"""Sample N windows of shard 1 from the pinned HF revision and from ModelScope's
current file, and report how many windows differ.  Cheap evidence of how much of the
shard the 2026-10 update changed, without downloading 29.6 GB twice."""
import concurrent.futures as cf
import hashlib
import urllib.request

SIZE = 29608446496
HF = ("https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/"
      "5348543e0147355ac9cbcb031184a3546350988e/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf")
MS = ("https://www.modelscope.cn/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/"
      "resolve/master/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf")
N = 16
WIN = 1 << 20


def digest(url, off):
    req = urllib.request.Request(url, headers={"Range": "bytes=%d-%d" % (off, off + WIN - 1),
                                              "User-Agent": "strata-setup"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return hashlib.sha256(r.read()).hexdigest()


def main():
    offs = [int(SIZE * (i + 0.5) / N) for i in range(N)]
    same = diff = err = 0
    with cf.ThreadPoolExecutor(6) as ex:
        for off in offs:
            fh = ex.submit(digest, HF, off)
            fm = ex.submit(digest, MS, off)
            try:
                a, b = fh.result(), fm.result()
            except Exception as e:  # noqa: BLE001
                err += 1
                print(off, "ERR", type(e).__name__, str(e)[:80], flush=True)
                continue
            ok = a == b
            same += ok
            diff += not ok
            print("%13d %s" % (off, "same" if ok else "DIFF"), flush=True)
    print("windows=%d same=%d diff=%d err=%d" % (N, same, diff, err))


if __name__ == "__main__":
    main()
