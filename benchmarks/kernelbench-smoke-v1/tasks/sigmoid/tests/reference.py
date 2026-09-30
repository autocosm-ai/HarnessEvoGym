import torch
import torch.nn as nn

class Model(nn.Module):
    """
    Simple model that performs a Sigmoid activation.
    """
    def __init__(self):
        super(Model, self).__init__()
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Applies Sigmoid activation to the input tensor.

        Args:
            x (torch.Tensor): Input tensor of any shape.

        Returns:
            torch.Tensor: Output tensor with Sigmoid applied, same shape as input.
        """
        return torch.sigmoid(x)

# Smoke 版沿用 KernelBench L1 Sigmoid 语义，但缩小输入，避免占满共享 GPU。
batch_size = 256
dim = 4096

def get_inputs():
    x = torch.rand(batch_size, dim)
    return [x]

def get_init_inputs():
    return []  # No special initialization inputs needed
