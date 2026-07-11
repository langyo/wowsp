"""Shared port utilities. Adapted from shittim-chest's scripts/utils/ports.py."""

import socket


def find_free_port(min_port: int = 60000, max_port: int = 65535) -> int:
    """Find an available TCP port in the given range."""
    for port in range(min_port, max_port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port found in {min_port}-{max_port}")


def wait_for_port(host: str, port: int, timeout: float = 10.0) -> bool:
    """Block until a TCP port accepts connections or timeout elapses."""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.2)
    return False
