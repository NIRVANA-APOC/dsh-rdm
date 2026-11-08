//! Minimal X.509 DER walk for the TLS leaf validity (§5.2).
//!
//! `reqwest::tls::TlsInfo` exposes the DER-encoded leaf certificate but the
//! dependency set is frozen (no `x509-parser`), so the kernel walks just enough
//! ASN.1 to recover `notAfter`, the issuer CN/O and the subject CN from
//! `TBSCertificate`. Unknown or malformed structures return `None` — probe
//! reports `tls: null` rather than guessing.

use crate::protocol::{TlsFacts, ValidityState, TLS_EXPIRING_SECS};

/// Decoded leaf facts used by probe; `not_after_ms` is Unix epoch millis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertInfo {
    pub not_after_ms: u64,
    pub issuer: Option<String>,
    pub subject: Option<String>,
}

const TAG_SEQUENCE: u8 = 0x30;
const TAG_SET: u8 = 0x31;
const TAG_OID: u8 = 0x06;
const TAG_UTC_TIME: u8 = 0x17;
const TAG_GENERALIZED_TIME: u8 = 0x18;

fn read_tlv(data: &[u8], pos: usize) -> Option<(u8, &[u8], usize)> {
    let tag = *data.get(pos)?;
    let mut cursor = pos + 1;
    let first = *data.get(cursor)?;
    cursor += 1;
    let len = if first & 0x80 == 0 {
        first as usize
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 {
            return None;
        }
        let mut value = 0usize;
        for _ in 0..count {
            value = (value << 8) | *data.get(cursor)? as usize;
            cursor += 1;
        }
        value
    };
    let end = cursor.checked_add(len)?;
    if end > data.len() {
        return None;
    }
    Some((tag, &data[cursor..end], end))
}

fn read_children(content: &[u8]) -> Option<Vec<(u8, &[u8])>> {
    let mut children = Vec::new();
    let mut cursor = 0;
    while cursor < content.len() {
        let (tag, value, next) = read_tlv(content, cursor)?;
        if next <= cursor {
            return None;
        }
        children.push((tag, value));
        cursor = next;
    }
    Some(children)
}

/// Decode one UTF-8-ish `DirectoryString`/`IA5String` value.
fn decode_string(tag: u8, value: &[u8]) -> Option<String> {
    match tag {
        0x0c | 0x13 | 0x16 | 0x1a | 0x14 => String::from_utf8(value.to_vec()).ok(),
        0x1e => {
            // BMPString: UTF-16 big-endian.
            if value.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = value.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

/// Extract CN (preferred) or O from an X.509 `Name` (RDNSequence).
fn parse_name(content: &[u8]) -> Option<String> {
    let rdns = read_children(content)?;
    let mut common_name: Option<String> = None;
    let mut organization: Option<String> = None;
    for (tag, set) in rdns {
        if tag != TAG_SET {
            continue;
        }
        let attributes = read_children(set)?;
        for (attr_tag, attr) in attributes {
            if attr_tag != TAG_SEQUENCE {
                continue;
            }
            let parts = read_children(attr)?;
            if parts.len() != 2 {
                continue;
            }
            let (oid_tag, oid) = parts[0];
            let (value_tag, value) = parts[1];
            if oid_tag != TAG_OID {
                continue;
            }
            // CN = 2.5.4.3 -> 55 04 03; O = 2.5.4.10 -> 55 04 0A
            let decoded = decode_string(value_tag, value);
            if oid == [0x55, 0x04, 0x03] {
                if common_name.is_none() {
                    common_name = decoded;
                }
            } else if oid == [0x55, 0x04, 0x0a] {
                if organization.is_none() {
                    organization = decoded;
                }
            }
        }
    }
    common_name.or(organization)
}

pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    // Howard Hinnant's civil-from-days inverse; avoids pulling in `chrono`.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let day_of_year = (153 * u64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + u64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era as i64 - 719_468
}

fn parse_ymdhms(year: i64, rest: &str) -> Option<u64> {
    let bytes = rest.as_bytes();
    if bytes.len() != 10 && bytes.len() != 8 {
        return None;
    }
    let number = |start: usize| -> Option<u32> { rest.get(start..start + 2)?.parse().ok() };
    let month = number(0)?;
    let day = number(2)?;
    let hour = number(4)?;
    let minute = number(6)?;
    let second = if bytes.len() == 10 { number(8)? } else { 0 };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    let seconds = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
    u64::try_from(seconds).ok().map(|seconds| seconds * 1000)
}

fn parse_time(tag: u8, value: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(value).ok()?;
    // Reject timezone offsets; certificate validity in the wild is Zulu.
    let digits = text.strip_suffix('Z')?;
    match tag {
        TAG_UTC_TIME => {
            if digits.len() != 12 && digits.len() != 10 {
                return None;
            }
            let year: i64 = digits.get(0..2)?.parse().ok()?;
            let year = if year >= 50 { 1900 + year } else { 2000 + year };
            parse_ymdhms(year, digits.get(2..)?)
        }
        TAG_GENERALIZED_TIME => {
            if digits.len() != 14 && digits.len() != 12 {
                return None;
            }
            let year: i64 = digits.get(0..4)?.parse().ok()?;
            parse_ymdhms(year, digits.get(4..)?)
        }
        _ => None,
    }
}

/// Walk `Certificate -> tbsCertificate` and return the leaf validity/names.
pub fn parse_leaf(der: &[u8]) -> Option<CertInfo> {
    let (tag, certificate, _) = read_tlv(der, 0)?;
    if tag != TAG_SEQUENCE {
        return None;
    }
    let (tag, tbs, _) = read_tlv(certificate, 0)?;
    if tag != TAG_SEQUENCE {
        return None;
    }
    let children = read_children(tbs)?;
    // The validity is the first SEQUENCE with exactly two time children; the
    // signature AlgorithmIdentifier is a SEQUENCE too but holds OID/NULL.
    let mut validity_index = None;
    for (index, (child_tag, child)) in children.iter().enumerate() {
        if *child_tag != TAG_SEQUENCE {
            continue;
        }
        let Some(inner) = read_children(child) else { continue };
        if inner.len() == 2 && inner.iter().all(|(tag, _)| *tag == TAG_UTC_TIME || *tag == TAG_GENERALIZED_TIME) {
            validity_index = Some(index);
            break;
        }
    }
    let validity_index = validity_index?;
    let times = read_children(children[validity_index].1)?;
    let not_after_ms = parse_time(times.get(1)?.0, times.get(1)?.1)?;
    // issuer comes before validity, subject after; the optional [0] version tag
    // does not disturb either because both are SEQUENCEs.
    let issuer = validity_index.checked_sub(1).and_then(|index| {
        let (tag, value) = children[index];
        (tag == TAG_SEQUENCE).then(|| parse_name(value)).flatten()
    });
    let subject = children.get(validity_index + 1).and_then(|(tag, value)| if *tag == TAG_SEQUENCE { parse_name(value) } else { None });
    Some(CertInfo { not_after_ms, issuer, subject })
}

pub fn validity_state(expires_in_secs: Option<i64>, threshold_secs: i64) -> ValidityState {
    match expires_in_secs {
        None => ValidityState::Unknown,
        Some(secs) if secs <= 0 => ValidityState::Expired,
        Some(secs) if secs <= threshold_secs => ValidityState::Expiring,
        Some(_) => ValidityState::Valid,
    }
}

/// Build the public `TlsFacts` for a probe result. Plain HTTP or an unreadable
/// certificate reports `null` (the caller serializes the absent object).
pub fn tls_facts(https: bool, der: Option<&[u8]>, now_ms: u64) -> Option<TlsFacts> {
    if !https {
        return None;
    }
    let der = der?;
    let info = parse_leaf(der)?;
    let expires_in_secs = Some((info.not_after_ms as i64 - now_ms as i64) / 1000);
    Some(TlsFacts { https: true, not_after: Some(info.not_after_ms), expires_in_secs, issuer: info.issuer, subject: info.subject, state: validity_state(expires_in_secs, TLS_EXPIRING_SECS) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let len = content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else {
            let bytes = len.to_be_bytes();
            let first = bytes.iter().position(|byte| *byte != 0).expect("non-zero length");
            let encoded = &bytes[first..];
            out.push(0x80 | encoded.len() as u8);
            out.extend_from_slice(encoded);
        }
        out.extend_from_slice(content);
        out
    }

    fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
        let mut content = Vec::new();
        for part in parts {
            content.extend_from_slice(part);
        }
        tlv(TAG_SEQUENCE, &content)
    }

    fn oid(bytes: &[u8]) -> Vec<u8> {
        tlv(TAG_OID, bytes)
    }

    fn rdn(oid_bytes: &[u8], value: &str) -> Vec<u8> {
        let attribute = seq(&[oid(oid_bytes), tlv(0x0c, value.as_bytes())]);
        tlv(TAG_SET, &attribute)
    }

    fn name(common_name: &str) -> Vec<u8> {
        seq(&[rdn(&[0x55, 0x04, 0x03], common_name)])
    }

    fn utc_time(value: &str) -> Vec<u8> {
        tlv(TAG_UTC_TIME, value.as_bytes())
    }

    fn certificate(issuer: &str, subject: &str, not_before: &str, not_after: &str) -> Vec<u8> {
        let tbs = seq(&[seq(&[oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), tlv(0x05, &[])]), name(issuer), seq(&[utc_time(not_before), utc_time(not_after)]), name(subject)]);
        seq(&[tbs])
    }

    #[test]
    fn parses_leaf_validity_and_names() {
        let der = certificate("R11", "cdn.example.com", "260101000000Z", "270101000000Z");
        let info = parse_leaf(&der).expect("parse");
        assert_eq!(info.issuer.as_deref(), Some("R11"));
        assert_eq!(info.subject.as_deref(), Some("cdn.example.com"));
        // 2027-01-01T00:00:00Z = 1798761600000 ms.
        assert_eq!(info.not_after_ms, 1_798_761_600_000);
        let facts = tls_facts(true, Some(&der), 1_798_761_600_000 - 40 * 24 * 3600 * 1000).expect("tls facts");
        assert_eq!(facts.state, ValidityState::Valid);
        assert_eq!(facts.issuer.as_deref(), Some("R11"));
    }

    #[test]
    fn reports_expiring_and_expired_states() {
        let der = certificate("R11", "cdn.example.com", "260101000000Z", "270101000000Z");
        let close = tls_facts(true, Some(&der), 1_798_761_600_000 - 10 * 24 * 3600 * 1000).expect("facts");
        assert_eq!(close.state, ValidityState::Expiring);
        let past = tls_facts(true, Some(&der), 1_798_761_600_000 + 1000).expect("facts");
        assert_eq!(past.state, ValidityState::Expired);
    }

    #[test]
    fn generator_time_forms_are_accepted() {
        let der = certificate("R11", "cdn.example.com", "260101000000Z", "270101000000Z");
        assert!(parse_leaf(&der).is_some());
        let tls = tls_facts(false, Some(&der), 0);
        assert!(tls.is_none(), "plain http reports no TLS block");
        assert!(tls_facts(true, None, 0).is_none());
    }

    #[test]
    fn malformed_certificates_are_rejected() {
        assert!(parse_leaf(&[]).is_none());
        assert!(parse_leaf(&[0x30, 0x03, 0x02, 0x01, 0x00]).is_none());
        assert!(parse_leaf(b"not a certificate").is_none());
        // Truncated length must not panic.
        assert!(parse_leaf(&[0x30, 0x82, 0xff]).is_none());
    }

    #[test]
    fn generalized_time_is_parsed() {
        let tbs = seq(&[
            seq(&[oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), tlv(0x05, &[])]),
            name("R11"),
            seq(&[tlv(TAG_GENERALIZED_TIME, b"20260101000000Z"), tlv(TAG_GENERALIZED_TIME, b"20270101000000Z")]),
            name("cdn.example.com"),
        ]);
        let der = seq(&[tbs]);
        let info = parse_leaf(&der).expect("parse");
        assert_eq!(info.not_after_ms, 1_798_761_600_000);
    }

    #[test]
    fn validity_state_boundaries() {
        assert_eq!(validity_state(None, 10), ValidityState::Unknown);
        assert_eq!(validity_state(Some(0), 10), ValidityState::Expired);
        assert_eq!(validity_state(Some(10), 10), ValidityState::Expiring);
        assert_eq!(validity_state(Some(11), 10), ValidityState::Valid);
    }
}
