variable "do_token" {
  description = "DigitalOcean API token (or set DIGITALOCEAN_TOKEN / TF_VAR_do_token)."
  type        = string
  sensitive   = true
}

variable "ssh_key_fingerprints" {
  description = "Fingerprints of SSH keys already uploaded to your DO account, added to every droplet."
  type        = list(string)
}

variable "region" {
  description = "DigitalOcean region slug."
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "Droplet size slug. 2GB gives headroom for the in-container image build."
  type        = string
  default     = "s-1vcpu-2gb"
}

variable "peer_count" {
  description = "Number of peer droplets to run alongside the single seed node."
  type        = number
  default     = 2
  validation {
    condition     = var.peer_count >= 0 && var.peer_count <= 20
    error_message = "peer_count must be between 0 and 20."
  }
}

variable "name_prefix" {
  description = "Prefix for droplet / resource names."
  type        = string
  default     = "smartsv"
}

variable "api_key" {
  description = "Bearer key required for mutating RPC routes. Generate with: openssl rand -hex 32"
  type        = string
  sensitive   = true
}

variable "domain" {
  description = "FQDN for the seed's public RPC (enables Let's Encrypt TLS). Empty => plain HTTP on :80."
  type        = string
  default     = ""
}

variable "mine_address" {
  description = "Address the seed node mines block rewards to. Create with: node bin/smartsv.js newkey"
  type        = string
}

variable "mine_interval" {
  description = "Seconds between auto-mined blocks on the seed."
  type        = number
  default     = 10
}

variable "git_repo" {
  description = "Git URL of this repository; droplets clone and build it."
  type        = string
}

variable "git_ref" {
  description = "Git branch or tag to deploy."
  type        = string
  default     = "main"
}

variable "admin_ssh_cidr" {
  description = "CIDR allowed to SSH (port 22). Restrict to your IP in production."
  type        = string
  default     = "0.0.0.0/0"
}
