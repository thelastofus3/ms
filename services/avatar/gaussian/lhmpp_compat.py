"""Compatibility for the published FLAME pickle's legacy Chumpy classes."""
import numpy as np


def enable_float32_sparse_convolutions(model):
    """Run Turing sparse convolutions with supported FP32 implicit GEMM."""
    import torch
    import spconv.pytorch as spconv
    from spconv.core import ConvAlgo

    def wrap(forward):
        def float32_forward(sparse):
            dtype = sparse.features.dtype
            with torch.autocast("cuda", enabled=False):
                result = forward(sparse.replace_feature(sparse.features.float()))
            return result.replace_feature(result.features.to(dtype))
        return float32_forward

    for module in model.modules():
        if isinstance(module, spconv.SubMConv3d):
            module.float()
            module.algo = ConvAlgo.MaskImplicitGemm
            module.forward = wrap(module.forward)


def enable_legacy_numpy_aliases():
    # Chumpy imports aliases removed in NumPy 1.24. These are the exact Python
    # types those deprecated aliases referred to; no model values are changed.
    for name, value in {'bool': bool, 'int': int, 'float': float, 'complex': complex,
                        'object': object, 'unicode': str, 'str': str}.items():
        np.__dict__.setdefault(name, value)
