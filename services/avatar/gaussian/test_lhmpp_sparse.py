import sys
sys.path.insert(0, '/experiment')
import torch
import spconv.pytorch as spconv
from spconv.core import ConvAlgo
from lhmpp_compat import enable_float32_sparse_convolutions
indices = torch.tensor([[0,x,y,z] for x in range(4) for y in range(4) for z in range(4)],device='cuda',dtype=torch.int32)
torch.manual_seed(42)
layer = spconv.SubMConv3d(64,64,3,bias=True).cuda().float().eval()
features = torch.randn(64,64,device='cuda',dtype=torch.float16)
with torch.inference_mode():
 expected = layer(spconv.SparseConvTensor(features.float(),indices,[4,4,4],1)).features.half()
enable_float32_sparse_convolutions(layer)
assert layer.algo == ConvAlgo.MaskImplicitGemm
with torch.inference_mode(), torch.autocast('cuda',dtype=torch.float16):
 actual = layer(spconv.SparseConvTensor(features,indices,[4,4,4],1)).features
torch.testing.assert_close(actual, expected,atol=0.0001,rtol=0.001)
assert actual.dtype == features.dtype
print('SPARSE_ADAPTER_PASS')
