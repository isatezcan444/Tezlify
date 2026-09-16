"""Host and system metrics service for Admin Center.

Invariants:
- Read-only inspection of host proc files and disk statistics.
- Safe fallbacks if running in container or unprivileged environment.
- Zero mutations.
"""

import os
import shutil
import time
from datetime import datetime, timezone
from typing import List

from backend.app.schemas.admin import AdminSystemInfo


def get_system_metrics() -> AdminSystemInfo:
    """Collects host resource utilization metrics."""
    now_iso = datetime.now(timezone.utc).isoformat()
    cpu_cores = os.cpu_count() or 1

    # 1. Load average
    loadavg: List[float] = [0.0, 0.0, 0.0]
    try:
        if hasattr(os, "getloadavg"):
            raw_load = os.getloadavg()
            loadavg = [round(float(x), 2) for x in raw_load[:3]]
        elif os.path.exists("/proc/loadavg"):
            with open("/proc/loadavg", "r") as f:
                parts = f.read().split()
                loadavg = [round(float(parts[i]), 2) for i in range(min(3, len(parts)))]
    except Exception:
        loadavg = [0.0, 0.0, 0.0]

    # 2. Memory
    total_mb = 0.0
    free_mb = 0.0
    available_mb = 0.0
    try:
        if os.path.exists("/proc/meminfo"):
            mem_data = {}
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        val_str = parts[1].strip().split()[0]
                        if val_str.isdigit():
                            mem_data[key] = int(val_str)
            total_kb = mem_data.get("MemTotal", 0)
            free_kb = mem_data.get("MemFree", 0)
            avail_kb = mem_data.get("MemAvailable", free_kb)
            total_mb = round(total_kb / 1024.0, 2)
            free_mb = round(free_kb / 1024.0, 2)
            available_mb = round(avail_kb / 1024.0, 2)
    except Exception:
        pass
    used_mb = max(0.0, round(total_mb - available_mb, 2))

    # 3. Disk usage
    disk_total_gb = 0.0
    disk_used_gb = 0.0
    disk_free_gb = 0.0
    disk_pct = 0.0
    try:
        du = shutil.disk_usage("/")
        disk_total_gb = round(du.total / (1024.0 ** 3), 2)
        disk_used_gb = round(du.used / (1024.0 ** 3), 2)
        disk_free_gb = round(du.free / (1024.0 ** 3), 2)
        if du.total > 0:
            disk_pct = round((du.used / du.total) * 100.0, 1)
    except Exception:
        pass

    # 4. Host uptime
    uptime_str = "unknown"
    try:
        if os.path.exists("/proc/uptime"):
            with open("/proc/uptime", "r") as f:
                raw_sec = float(f.read().split()[0])
                days = int(raw_sec // 86400)
                hours = int((raw_sec % 86400) // 3600)
                minutes = int((raw_sec % 3600) // 60)
                parts = []
                if days > 0:
                    parts.append(f"{days} day{'s' if days > 1 else ''}")
                if hours > 0 or days > 0:
                    parts.append(f"{hours} hour{'s' if hours > 1 else ''}")
                parts.append(f"{minutes} minute{'s' if minutes > 1 else ''}")
                uptime_str = "up " + ", ".join(parts)
    except Exception:
        uptime_str = "unknown"

    # 5. Reboot required
    reboot_required = False
    for path in [
        "/var/run/reboot-required",
        "/run/reboot-required",
        "/host/run/reboot-required",
        "/host/var/run/reboot-required",
    ]:
        if os.path.exists(path):
            reboot_required = True
            break

    return AdminSystemInfo(
        timestamp=now_iso,
        load_average=loadavg,
        cpu_cores=cpu_cores,
        memory_total_mb=total_mb,
        memory_used_mb=used_mb,
        memory_available_mb=available_mb,
        disk_total_gb=disk_total_gb,
        disk_used_gb=disk_used_gb,
        disk_free_gb=disk_free_gb,
        disk_used_percent=disk_pct,
        uptime=uptime_str,
        reboot_required=reboot_required,
    )
