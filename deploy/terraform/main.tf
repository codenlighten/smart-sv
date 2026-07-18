# SmartSV network on DigitalOcean: a private VPC, a mining seed node with a
# stable reserved IP, `peer_count` peer droplets that dial the seed over the VPC,
# and a cloud firewall. Each droplet self-provisions via cloud-init (Docker +
# the node + Caddy).

locals {
  # Domain drives Caddy TLS; only the seed gets the public FQDN.
  seed_domain = var.domain != "" ? var.domain : ":80"

  seed_user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    role          = "seed"
    api_key       = var.api_key
    domain        = local.seed_domain
    mine_address  = var.mine_address
    mine_interval = var.mine_interval
    connect       = ""
    git_repo      = var.git_repo
    git_ref       = var.git_ref
  })
}

resource "digitalocean_vpc" "net" {
  name   = "${var.name_prefix}-vpc"
  region = var.region
}

# --- Seed node (stable reserved IP so peers/DNS have a fixed target) ---------

resource "digitalocean_droplet" "seed" {
  name      = "${var.name_prefix}-seed"
  image     = "debian-12-x64"
  region    = var.region
  size      = var.droplet_size
  vpc_uuid  = digitalocean_vpc.net.id
  ssh_keys  = var.ssh_key_fingerprints
  user_data = local.seed_user_data

  tags = ["${var.name_prefix}", "${var.name_prefix}-seed"]
}

resource "digitalocean_reserved_ip" "seed" {
  region = var.region
}

resource "digitalocean_reserved_ip_assignment" "seed" {
  ip_address = digitalocean_reserved_ip.seed.ip_address
  droplet_id = digitalocean_droplet.seed.id
}

# --- Peer nodes (dial the seed over the private VPC address) -----------------

resource "digitalocean_droplet" "peer" {
  count    = var.peer_count
  name     = "${var.name_prefix}-peer-${count.index + 1}"
  image    = "debian-12-x64"
  region   = var.region
  size     = var.droplet_size
  vpc_uuid = digitalocean_vpc.net.id
  ssh_keys = var.ssh_key_fingerprints

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    role          = "peer"
    api_key       = var.api_key
    domain        = ":80"
    mine_address  = ""
    mine_interval = var.mine_interval
    connect       = "${digitalocean_droplet.seed.ipv4_address_private}:8433"
    git_repo      = var.git_repo
    git_ref       = var.git_ref
  })

  tags = ["${var.name_prefix}", "${var.name_prefix}-peer"]
}

# --- Cloud firewall (applies to every node) ----------------------------------

resource "digitalocean_firewall" "net" {
  name = "${var.name_prefix}-fw"

  droplet_ids = concat(
    [digitalocean_droplet.seed.id],
    digitalocean_droplet.peer[*].id,
  )

  # SSH — restrict to your address in production via admin_ssh_cidr.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = [var.admin_ssh_cidr]
  }
  # HTTP + HTTPS (Caddy / public RPC).
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  # P2P — open so external nodes can join the network.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "8433"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all egress.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
