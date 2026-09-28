"""Inference-only replacement for Sonata's packed FlashAttention call on Turing."""

import torch
from xformers.ops import memory_efficient_attention
from xformers.ops.fmha.attn_bias import BlockDiagonalMask


def packed_attention(qkv, cu_seqlens, max_seqlen, dropout_p=0.0, softmax_scale=None):
    if not torch.isfinite(qkv).all():
        raise FloatingPointError("Nonfinite packed attention input (possible FP16 overflow)")
    if dropout_p != 0:
        raise ValueError("This adapter only supports inference without dropout")
    lengths = (cu_seqlens[1:] - cu_seqlens[:-1]).tolist()
    if not lengths or min(lengths) <= 0 or max(lengths) > max_seqlen:
        raise ValueError("Invalid packed attention sequence lengths")
    if cu_seqlens[0].item() != 0 or cu_seqlens[-1].item() != len(qkv):
        raise ValueError("Packed offsets must cover every input token")
    query, key, value = qkv.unbind(1)
    bias = BlockDiagonalMask.from_seqlens(lengths)
    return memory_efficient_attention(
        query.unsqueeze(0),
        key.unsqueeze(0),
        value.unsqueeze(0),
        attn_bias=bias,
        p=0.0,
        scale=softmax_scale,
    ).squeeze(0)
