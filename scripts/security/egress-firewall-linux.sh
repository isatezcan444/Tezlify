#!/usr/bin/env bash
# Tezlify WhatsApp - Linux Kernel-Level Network Egress Isolation Specification
# For production Linux / CI environments utilizing Linux Network Namespaces & nftables.
#
# On macOS development environments, kernel isolation is enforced natively via
# Apple Seatbelt MAC framework (/usr/bin/sandbox-exec) without modifying host firewall.
# On Linux environments, execute this script with root privileges to establish
# an isolated network namespace with hardware/kernel-level default DROP policies.

set -euo pipefail

NS_NAME="${1:-tezlify-egress-isolated}"

echo "Configuring Linux Kernel Network Namespace: ${NS_NAME}..."

# 1. Create isolated network namespace if not existing
if ! ip netns list | grep -q "${NS_NAME}"; then
  ip netns add "${NS_NAME}"
fi

# 2. Bring up loopback interface only (no external veth or bridge to WAN)
ip -n "${NS_NAME}" link set lo up

# 3. Configure nftables with strict default DROP policy for OUTPUT
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
