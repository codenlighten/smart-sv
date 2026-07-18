# SmartSV — dev, container, and deploy helpers.
# `docker compose` (v2 plugin) is preferred; falls back to docker-compose (v1).

COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
PROJECT := smartsv
TF := terraform
TFDIR := deploy/terraform

.PHONY: help install test build up down logs ps keygen apikey \
        tf-init tf-plan tf-apply tf-destroy tf-fmt tf-validate

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install node dependencies
	npm ci

test: ## Run the full test suite (e2e, persist, reorg, p2p, p2p-reorg)
	npm test

# --- local containers ------------------------------------------------------

build: ## Build the Docker image
	docker build -t $(PROJECT):local .

up: ## Start the local 3-node network + Caddy (needs .env)
	@test -f .env || (echo "Create .env from .env.example first"; exit 1)
	$(COMPOSE) -p $(PROJECT) up -d --build

down: ## Stop the local network and remove volumes
	$(COMPOSE) -p $(PROJECT) down -v

logs: ## Tail all container logs
	$(COMPOSE) -p $(PROJECT) logs -f

ps: ## Show container status
	$(COMPOSE) -p $(PROJECT) ps

# --- helpers ---------------------------------------------------------------

keygen: ## Generate a new SmartSV key (wif/address)
	@node bin/smartsv.js newkey

apikey: ## Generate a strong API key
	@openssl rand -hex 32

# --- DigitalOcean via Terraform --------------------------------------------

tf-init: ## terraform init
	cd $(TFDIR) && $(TF) init

tf-fmt: ## terraform fmt
	cd $(TFDIR) && $(TF) fmt -recursive

tf-validate: ## terraform validate
	cd $(TFDIR) && $(TF) validate

tf-plan: ## terraform plan (reads terraform.tfvars)
	cd $(TFDIR) && $(TF) plan

tf-apply: ## Provision the network on DigitalOcean
	cd $(TFDIR) && $(TF) apply

tf-destroy: ## Tear down the DigitalOcean network
	cd $(TFDIR) && $(TF) destroy
