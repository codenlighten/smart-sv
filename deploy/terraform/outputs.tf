output "seed_reserved_ip" {
  description = "Stable public IP for the seed. Point your DNS A record here."
  value       = digitalocean_reserved_ip.seed.ip_address
}

output "seed_public_ip" {
  description = "The seed droplet's own public IPv4."
  value       = digitalocean_droplet.seed.ipv4_address
}

output "seed_private_ip" {
  description = "The seed's VPC-private IPv4 (peers dial this on :8433)."
  value       = digitalocean_droplet.seed.ipv4_address_private
}

output "peer_public_ips" {
  description = "Public IPv4 of each peer droplet."
  value       = digitalocean_droplet.peer[*].ipv4_address
}

output "rpc_url" {
  description = "Base URL for the public RPC/WS API."
  value       = var.domain != "" ? "https://${var.domain}" : "http://${digitalocean_reserved_ip.seed.ip_address}"
}

output "next_steps" {
  description = "What to do after apply."
  value       = <<-EOT
    1. If using a domain, create a DNS A record:  ${var.domain} -> ${digitalocean_reserved_ip.seed.ip_address}
       (Caddy will obtain a Let's Encrypt certificate automatically.)
    2. Wait ~2-3 min for cloud-init (Docker install + image build) to finish.
    3. Health:   curl ${var.domain != "" ? "https://${var.domain}" : "http://${digitalocean_reserved_ip.seed.ip_address}"}/health
       Status:   curl ${var.domain != "" ? "https://${var.domain}" : "http://${digitalocean_reserved_ip.seed.ip_address}"}/info
    4. Mine/broadcast (needs the API key):
         export SMARTSV_URL=${var.domain != "" ? "https://${var.domain}" : "http://${digitalocean_reserved_ip.seed.ip_address}"}
         export SMARTSV_API_KEY=<your key>
         node bin/smartsv.js info
  EOT
}
