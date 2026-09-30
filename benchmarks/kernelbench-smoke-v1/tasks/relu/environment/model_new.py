import torch
import torch.nn as nn


class ModelNew(nn.Module):
    """KernelBench smoke baseline；Updater 可以在此文件中实现更快的 Kernel。"""

    def __init__(self):
        super().__init__()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.relu(x)
