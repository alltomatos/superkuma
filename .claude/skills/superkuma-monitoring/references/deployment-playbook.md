# Deploying a new SuperKuma instance

How to stand up a **fresh SuperKuma instance** itself (not monitors on an existing one) — on a
client's own infrastructure, typically a Proxmox VE host reached over VPN. Covers the concrete
pitfalls hit deploying to `omniroute` and a client's Proxmox cluster; read this before the
[onboarding workflow](../SKILL.md#onboarding-workflow), which assumes the instance already exists.

## 0. Find the target host

Confirm VPN/network reach first (`ping` the gateway), then discover live hosts if you don't
already have a specific target:

```bash
# Windows without nmap yet:
winget install -e --id Insecure.Nmap --accept-source-agreements --accept-package-agreements
# add to PATH for this session: export PATH="$PATH:/c/Program Files (x86)/Nmap"

nmap -sn 192.168.0.0/24                                   # live hosts
nmap -p 22,80,443,3389,8006 -T4 <comma-separated-live-ips>  # role fingerprint:
#   22+8006 open  -> Proxmox VE node
#   3389 open     -> Windows (RDP)
#   22 only       -> plain Linux server
```

**Ask the client which IP convention applies** before assigning anything — e.g. "DHCP is
.100–.200, services/infra must sit below .99" is a real convention we hit; guessing wrong means
redoing the network config later. Also check for a site credentials file (client may already keep
one, e.g. `root` / a shared "default Linux password" convention) rather than guessing logins.

## 1. Proxmox: VM, not LXC, for Docker workloads

**LXC containers are NOT a reliable Docker host**, even privileged with `nesting=1,keyctl=1`. A
current Docker/containerd/runc stack (containerd 2.x+) tries to set the
`net.ipv4.ip_unprivileged_port_start` sysctl on every container start, which LXC's namespaced
`/proc/sys/net` blocks — this fails identically whether the LXC is unprivileged or privileged:

```
OCI runtime create failed: runc create failed: ... open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Don't spend time patching around this (custom AppArmor profiles / `lxc.mount.entry` hacks) — just
use a **full VM**. It costs a few extra minutes (image download, cloud-init) and just works.

```bash
# On the Proxmox node, via SSH:
pveam update
pveam available --section system | grep debian-12   # if you want an LXC template for something else

# VM path (what actually works for Docker):
cd /var/lib/vz/template/iso
curl -fsSL -o debian-12-generic-amd64.qcow2 https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2

qm create <vmid> --name superkuma --memory 4096 --cores 2 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci --ostype l26
qm importdisk <vmid> /var/lib/vz/template/iso/debian-12-generic-amd64.qcow2 local-lvm
qm set <vmid> --scsi0 local-lvm:vm-<vmid>-disk-0
qm set <vmid> --ide2 local-lvm:cloudinit
qm set <vmid> --boot order=scsi0
qm set <vmid> --serial0 socket --vga serial0   # console access without X/VNC
qm resize <vmid> scsi0 +16G                    # cloud images ship tiny (~3G) by default
```

### Cloud-init network + access

Cloud images **disable password SSH login by default** — setting `--cipassword` alone won't get
you in; you'll see `FATAL ERROR: No supported authentication methods available (server sent:
publickey)`. Generate a dedicated keypair and inject the public key instead:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/<client>_superkuma -N "" -C "superkuma-<client>-deploy"
scp ~/.ssh/<client>_superkuma.pub root@<proxmox-host>:/tmp/superkuma.pub

qm set <vmid> --ipconfig0 ip=<static-ip>/24,gw=<gateway>   # a static IP in the "infra" range, not DHCP
qm set <vmid> --ciuser root --sshkeys /tmp/superkuma.pub
qm start <vmid>
```

Changing `--sshkeys`/`--ipconfig0`/`--cipassword` on an already-booted VM and rebooting **does**
re-apply those specific cloud-init modules (Proxmox's NoCloud datasource supports this) — no need
to recreate the VM from scratch if you got the network/access config wrong the first time.

Then just: `curl -fsSL https://get.docker.com | sh` — works cleanly on a real VM kernel, no
sysctl/namespace fights.

## 2. Deploy: Docker Compose, MariaDB from the start

Reuse the same shape as every other instance this skill has deployed: SuperKuma + MariaDB (per
[ADR-0009](../../../../docs/adr/0009-master-long-term-metrics-history.md) — MariaDB is the
recommended engine beyond a small standalone), on their own bridge network, MariaDB **never**
published on a host port:

```yaml
services:
  superkuma:
    image: ronaldodavi/superkuma:<version> # check the latest tag on Docker Hub
    container_name: superkuma
    restart: unless-stopped
    depends_on: [mariadb]
    environment:
      SUPERKUMA_MCP_HTTP_ENABLED: "true"
      SUPERKUMA_ALLOW_MUTATIONS: "true"
      SUPERKUMA_ALLOW_DELETE: "false"
    volumes: ["./data:/app/data"]
    ports: ["3001:3001"]
    networks: [superkuma-net]

  mariadb:
    image: mariadb:11
    container_name: superkuma-mariadb
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: superkuma
      MARIADB_USER: superkuma
      MARIADB_PASSWORD: "<generate remotely, see below>"
      MARIADB_RANDOM_ROOT_PASSWORD: "yes"
    volumes: ["./mariadb-data:/var/lib/mysql"]
    networks: [superkuma-net]

networks:
  superkuma-net: { driver: bridge }
```

Complete the DB setup via the REST endpoint (no UI needed, works before any user exists):

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"dbConfig":{"type":"mariadb","port":3306,"hostname":"mariadb","username":"superkuma","password":"<pw>","dbName":"superkuma","ssl":false,"ca":""}}' \
  http://localhost:3001/setup-database
# {"ok":true} on success
```

### Gotcha: changing the MariaDB password later requires wiping the bind-mounted data dir

`MARIADB_PASSWORD` (and `MARIADB_DATABASE`/`MARIADB_USER`) only take effect on the **first** boot
against an _empty_ data directory. Because `./mariadb-data` is a host bind mount (not a fresh named
volume each time), simply editing the compose file's password and recreating the container reuses
the already-initialized MySQL data files with the OLD password — `docker compose down` alone does
**not** clear a bind mount, and `docker volume rm <name>` will report "no such volume" (there's no
named volume to remove). If you need to fix/rotate the password before real data exists:

```bash
docker compose stop mariadb
rm -rf ./mariadb-data/*        # only do this if there's no real data yet
docker compose up -d mariadb
sleep 10                       # first-time init takes longer than a normal restart
```

## 3. Windows-as-controller pitfalls (git-bash / PowerShell orchestrating Linux hosts)

If you're driving all this from a Windows machine over SSH:

- **Never build a secret (password, JSON payload) by piping it through a step that touched a
  Windows-authored text file.** A password inserted into a template file via local `sed`/an editor
  can pick up a trailing `\r` (CRLF) invisibly — `cat`/most terminals don't show it, but it lands
  **inside** a quoted value once re-embedded in JSON, producing a confusing
  `Access denied for user ... (using password: YES)` or `Unterminated string in JSON` error whose
  cause isn't obvious from the message. Fix/avoidance: generate secrets **on the remote Linux host**
  (`openssl rand -hex 24`) and build payloads there too, in a **single-line** `printf`, e.g.:
  `printf '{"a":"%s"}' "$VAR" > file.json` — don't heredoc multi-line content through an SSH
  command from Windows (also observed corrupting content the same way). If you ever suspect this,
  `od -c file.json | tail` to check for a stray `\r` before the closing quote.
- **Prefer native `ssh`/`scp`/`ssh-keygen`** (git-bash ships real OpenSSH) over `plink`/`pscp` when
  both are viable — PuTTY's host-key cache and fingerprint format differ enough from OpenSSH's
  `known_hosts` that you'll otherwise juggle two host-key trust stores for the same set of hosts.
  Only reach for `plink -pw` when you specifically need password-based (non-key) auth that the
  native client can't do non-interactively.
- Tools you may need to install fresh on a clean Windows box: `winget install -e --id
Insecure.Nmap`, `winget install -e --id PuTTY.PuTTY` (only if you specifically need password-SSH
  automation).

## 4. Verify

```bash
docker ps --format "{{.Names}}: {{.Status}}"      # both containers healthy
curl -s http://<ip>:3001/api/entry-page            # {"type":"entryPage","entryPage":null} once set up
```

Then hand off the URL for the human to create the admin account (don't do this yourself — account
creation/passwords are the user's call), and once they have an API key, proceed with the
[onboarding workflow](../SKILL.md#onboarding-workflow).
