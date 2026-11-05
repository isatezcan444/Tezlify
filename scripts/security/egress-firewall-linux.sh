#!/usr/bin/env bash
# Tezlify WhatsApp - Linux Kernel-Level Network Egress Isolation Specification
# For production Linux / CI environments utilizing Linux Network Namespaces & nftables.
#
# On macOS development environments, kernel isolation is enforced natively via
# Apple Seatbelt MAC framework (/usr/bin/sandbox-exec) without modifying host firewall.
# On Linux environments, execute this script with root privileges to establish
# an isolated network namespace with hardware/kernel-level default DROP policies.

set -euo pipefail

NS_NAME="tezlify-egress-isolated"
ACTION="setup"

for arg in "$@"; do
  case "$arg" in
    --cleanup|--delete|-d)
      ACTION="cleanup"
      ;;
    --name=*)
      NS_NAME="${arg#*=}"
      ;;
    --help|-h)
      echo "Usage: $0 [--cleanup] [--name=<namespace_name>]"
      exit 0
      ;;
    *)
      if [ -n "$arg" ] && [ "$arg" != "cleanup" ]; then
        NS_NAME="$arg"
      fi
      ;;
  esac
done

if [ "${1:-}" = "cleanup" ]; then
  ACTION="cleanup"
fi

if [ "$ACTION" = "cleanup" ]; then
  echo "Rolling back and destroying Linux Kernel Network Namespace: ${NS_NAME}..."
  if command -v ip >/dev/null 2>&1 && ip netns list | grep -q "${NS_NAME}"; then
    ip netns del "${NS_NAME}"
    echo "Namespace ${NS_NAME} deleted. Host firewall untouched."
  else
    echo "Namespace ${NS_NAME} does not exist. Nothing to clean."
  fi
  exit 0
fi

# Ensure root privileges on Linux
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Linux kernel namespace configuration requires root privileges (sudo)." >&2
  exit 1
fi

echo "Configuring Linux Kernel Network Namespace: ${NS_NAME}..."

# 1. Create isolated network namespace if not existing
if ! ip netns list | grep -q "${NS_NAME}"; then
  ip netns add "${NS_NAME}"
fi

# 2. Bring up loopback interface only (no external veth or bridge to WAN)
ip -n "${NS_NAME}" link set lo up

# 3. Configure nftables with strict default DROP policy for OUTPUT inside the namespace
# Note: table inet filter is scoped EXCLUSIVELY to $NS_NAME; host tables are NOT affected.
ip netns exec "${NS_NAME}" nft -f - <<EOF
table inet filter {
    chain output {
        type filter hook output priority 0; policy drop;

        # Allow local loopback traffic (127.0.0.1 / ::1)
        oif "lo" accept

        # Track and drop any WAN egress attempt (IPv4, IPv6, TCP, UDP, DNS)
        counter drop
    }
}
EOF

echo "Linux Kernel Network Namespace configured successfully."
echo "Active nftables ruleset in namespace ${NS_NAME}:"
ip netns exec "${NS_NAME}" nft list table inet filter
