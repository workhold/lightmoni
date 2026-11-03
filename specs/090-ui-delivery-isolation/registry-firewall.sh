#!/bin/sh
# managed-by-lightmoni: abc-demo-registry-network-v2
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
iptables=/usr/sbin/iptables
chain=LMREGISTRY_20000
/usr/sbin/ip -o -4 addr show dev eth0 | /usr/bin/awk '{print $4}' | /usr/bin/grep -Fxq '172.21.0.16/20'
if ! "$iptables" --wait 5 -S DOCKER-USER >/dev/null 2>&1; then
  "$iptables" --wait 5 -N DOCKER-USER
fi
if ! "$iptables" --wait 5 -S "$chain" >/dev/null 2>&1; then
  "$iptables" --wait 5 -N "$chain"
fi
if ! "$iptables" --wait 5 -C "$chain" -s 172.21.0.0/20 -j RETURN >/dev/null 2>&1; then
  "$iptables" --wait 5 -I "$chain" 1 -s 172.21.0.0/20 -j RETURN
fi
if ! "$iptables" --wait 5 -C "$chain" -j DROP >/dev/null 2>&1; then
  "$iptables" --wait 5 -A "$chain" -j DROP
fi
for port in 20000 20001 20002; do
  if ! "$iptables" --wait 5 -C DOCKER-USER -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 172.21.0.16 --ctorigdstport "$port" -m comment --comment lightmoni-registry-private -j "$chain" >/dev/null 2>&1; then
    "$iptables" --wait 5 -I DOCKER-USER 1 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 172.21.0.16 --ctorigdstport "$port" -m comment --comment lightmoni-registry-private -j "$chain"
  fi
done
