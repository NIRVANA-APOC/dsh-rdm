use crate::protocol::{MAX_AUTO_CHUNK_SIZE, MIN_CHUNK_SIZE};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkPlan {
    pub total: u64,
    pub chunk_size: u64,
    pub total_chunks: u64,
}
impl ChunkPlan {
    pub fn new(total: u64, connections: usize, requested: u64) -> Self {
        let connections = connections.max(1) as u64;
        let chunk_size = if requested > 0 {
            requested
        } else {
            // Auto mode: four chunks per connection, so every worker starts with
            // a queued tail to steal from. A 256 KiB request is the smallest that
            // still amortizes HTTP round trips; 8 MiB caps the state file and the
            // slow tail of a multi-gigabyte transfer on one connection.
            let floor = MIN_CHUNK_SIZE.min(total.max(1));
            (total / (connections * 4)).clamp(floor, MAX_AUTO_CHUNK_SIZE)
        };
        Self::with_chunk_size(total, chunk_size)
    }
    pub fn with_chunk_size(total: u64, chunk_size: u64) -> Self {
        let chunk_size = chunk_size.max(1);
        let total_chunks = if total == 0 { 0 } else { total.div_ceil(chunk_size) };
        Self { total, chunk_size, total_chunks }
    }
    pub fn chunk_len(&self, index: u64) -> u64 {
        if index >= self.total_chunks {
            return 0;
        }
        (self.total - index * self.chunk_size).min(self.chunk_size)
    }
    pub fn byte_range(&self, index: u64) -> (u64, u64) {
        let start = index * self.chunk_size;
        (start, start + self.chunk_len(index))
    }
}
pub fn split_work(missing: Vec<(u64, u64)>, chunk_size: u64) -> Vec<(u64, u64)> {
    let chunk_size = chunk_size.max(1);
    let mut work = Vec::new();
    for (start, end) in missing {
        let mut cursor = start;
        while cursor < end {
            let next = (cursor + chunk_size).min(end);
            work.push((cursor, next));
            cursor = next;
        }
    }
    work
}
pub fn covered_chunks(plan: &ChunkPlan, ranges: &[(u64, u64)]) -> u64 {
    let mut covered = 0;
    for index in 0..plan.total_chunks {
        let (start, end) = plan.byte_range(index);
        let done = ranges.iter().any(|&(range_start, range_end)| range_start <= start && range_end >= end);
        if done {
            covered += 1;
        }
    }
    covered
}
