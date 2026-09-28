"""Run inside avatar-lhmpp: pytest /experiment/test_lhmpp_attention.py -q."""

import torch

from lhmpp_attention import packed_attention


def test_turing_packed_attention_matches_independent_sequences():
    torch.manual_seed(13)
    qkv = torch.randn(23, 3, 4, 16, device="cuda", dtype=torch.float16)
    offsets = torch.tensor([0, 7, 23], dtype=torch.int32, device="cuda")
    expected = []
    for start, end in [(0, 7), (7, 23)]:
        q, k, v = qkv[start:end].float().unbind(1)
        scores = torch.einsum("qhd,khd->hqk", q, k) * 0.17
        expected.append(torch.einsum("hqk,khd->qhd", scores.softmax(-1), v))
    result = packed_attention(qkv, offsets, max_seqlen=16, softmax_scale=0.17)
    torch.testing.assert_close(
        result.float(), torch.cat(expected), atol=0.003, rtol=0.003
    )
    changed = qkv.clone()
    changed[7:, 2] += 100
    changed_result = packed_attention(
        changed, offsets, max_seqlen=16, softmax_scale=0.17
    )
    torch.testing.assert_close(changed_result[:7], result[:7])
