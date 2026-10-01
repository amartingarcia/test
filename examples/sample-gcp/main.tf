# Synthetic GCP platform (invented names/values; no real data).

resource "google_compute_network" "main" {
  name                    = "vpc-${var.env}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "gke" {
  name          = "snet-gke"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.30.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.64.0.0/14"
  }
}

resource "google_compute_subnetwork" "data" {
  name          = "snet-data"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.30.16.0/24"
}

resource "google_compute_firewall" "internal" {
  name    = "allow-internal"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
  }
  source_ranges = ["10.30.0.0/16"]
}

resource "google_compute_router" "main" {
  name    = "router-${var.env}"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name                               = "nat-${var.env}"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_service_account" "nodes" {
  account_id   = "gke-nodes"
  display_name = "GKE nodes"
}

resource "google_service_account" "workload" {
  account_id   = "app-workload"
  display_name = "Application workload identity"
}

resource "google_project_iam_member" "nodes_logging" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.workload.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project}.svc.id.goog[shop/web]"
}

resource "google_container_cluster" "gke" {
  name       = "gke-${var.env}"
  location   = var.region
  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.gke.id

  remove_default_node_pool = true
  initial_node_count       = 1

  release_channel {
    channel = var.release_channel
  }

  workload_identity_config {
    workload_pool = "${var.project}.svc.id.goog"
  }
}

resource "google_container_node_pool" "general" {
  name       = "general"
  cluster    = google_container_cluster.gke.name
  location   = var.region
  node_count = var.nodes

  node_config {
    machine_type    = var.machine_type
    service_account = google_service_account.nodes.email

    labels = {
      workload = "general"
    }
  }

  autoscaling {
    min_node_count = var.nodes
    max_node_count = var.max_nodes
  }
}

resource "google_container_node_pool" "spot" {
  count    = var.enable_spot_pool ? 1 : 0
  name     = "spot"
  cluster  = google_container_cluster.gke.name
  location = var.region

  node_config {
    machine_type = "e2-standard-8"
    spot         = true

    labels = {
      workload = "batch"
    }

    taint {
      key    = "batch"
      value  = "true"
      effect = "NO_SCHEDULE"
    }
  }

  autoscaling {
    min_node_count = 0
    max_node_count = 20
  }
}

resource "google_sql_database_instance" "pg" {
  name             = "pg-${var.env}"
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    tier = var.sql_tier

    ip_configuration {
      private_network = google_compute_network.main.id
    }
  }
}

resource "google_redis_instance" "cache" {
  count              = var.enable_redis ? 1 : 0
  name               = "redis-${var.env}"
  region             = var.region
  memory_size_gb     = var.redis_gb
  authorized_network = google_compute_network.main.id
}

resource "google_compute_instance" "bastion" {
  name         = "bastion"
  machine_type = "e2-small"
  zone         = "${var.region}-b"

  network_interface {
    subnetwork = google_compute_subnetwork.data.id
  }
}

resource "google_compute_region_backend_service" "api" {
  name   = "api"
  region = var.region
}

resource "google_compute_forwarding_rule" "ilb" {
  name                  = "ilb-api"
  region                = var.region
  load_balancing_scheme = "INTERNAL"
  network               = google_compute_network.main.id
  subnetwork            = google_compute_subnetwork.gke.id
  backend_service       = google_compute_region_backend_service.api.id
}

resource "google_storage_bucket" "assets" {
  name     = "assets-${var.project}-${var.env}"
  location = var.region
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "images"
  format        = "DOCKER"
}

resource "google_secret_manager_secret" "db" {
  secret_id = "db-password"

  replication {
    auto {}
  }
}

resource "google_dns_managed_zone" "main" {
  name     = "sample-zone"
  dns_name = "sample.example.com."
}

resource "google_dns_record_set" "app" {
  name         = "app.sample.example.com."
  managed_zone = google_dns_managed_zone.main.name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_forwarding_rule.ilb.ip_address]
}
