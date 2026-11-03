"""GPU 验收夹具：实际 NVCC 编译分块矩阵乘法，不作为搜索效果证据。"""
import torch
import torch.nn as nn
from torch.utils.cpp_extension import load_inline

_module = load_inline(
    name="harness_cuda_matmul_probe",
    cpp_sources="torch::Tensor matmul_cuda(torch::Tensor a, torch::Tensor b);",
    cuda_sources=r"""
#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>
#include <cuda_runtime.h>

__global__ void multiply(const float* a, const float* b, float* out, int m, int k, int n) {
    __shared__ float tile_a[16][16], tile_b[16][16];
    int row = blockIdx.y * 16 + threadIdx.y;
    int col = blockIdx.x * 16 + threadIdx.x;
    float value = 0.0f;
    for (int tile = 0; tile < (k + 15) / 16; ++tile) {
        int ai = tile * 16 + threadIdx.x;
        int bi = tile * 16 + threadIdx.y;
        tile_a[threadIdx.y][threadIdx.x] = row < m && ai < k ? a[row*k + ai] : 0.0f;
        tile_b[threadIdx.y][threadIdx.x] = bi < k && col < n ? b[bi*n + col] : 0.0f;
        __syncthreads();
        for (int j = 0; j < 16; ++j) value += tile_a[threadIdx.y][j] * tile_b[j][threadIdx.x];
        __syncthreads();
    }
    if (row < m && col < n) out[row*n + col] = value;
}

torch::Tensor matmul_cuda(torch::Tensor a, torch::Tensor b) {
    TORCH_CHECK(a.is_cuda() && b.is_cuda() && a.is_contiguous() && b.is_contiguous());
    TORCH_CHECK(a.scalar_type() == torch::kFloat32 && b.scalar_type() == torch::kFloat32);
    TORCH_CHECK(a.dim() == 2 && b.dim() == 2 && a.size(1) == b.size(0));
    int m=a.size(0), k=a.size(1), n=b.size(1);
    auto out = torch::empty({m, n}, a.options());
    multiply<<<dim3((n+15)/16, (m+15)/16), dim3(16,16), 0, at::cuda::getCurrentCUDAStream()>>>(
        a.data_ptr<float>(), b.data_ptr<float>(), out.data_ptr<float>(), m,k,n);
    return out;
}
""",
    functions=["matmul_cuda"],
    extra_cuda_cflags=["-O3"],
    verbose=False,
)


class ModelNew(nn.Module):
    def forward(self, a, b):
        return _module.matmul_cuda(a, b)
