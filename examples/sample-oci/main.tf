# Synthetic OCI platform (invented names/values; no real data).

resource "oci_identity_compartment" "platform" {
  compartment_id = var.tenancy_ocid
  name           = "platform-${var.env}"
  description    = "Platform resources (${var.env})"
}

resource "oci_core_vcn" "main" {
  compartment_id = oci_identity_compartment.platform.id
  cidr_blocks    = ["10.40.0.0/16"]
  display_name   = "vcn-${var.env}"
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_nat_gateway" "nat" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_service_gateway" "sgw" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id

  services {
    service_id = var.service_gateway_service_id
  }
}

resource "oci_core_route_table" "public" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id

  route_rules {
    network_entity_id = oci_core_internet_gateway.igw.id
    destination       = "0.0.0.0/0"
  }
}

resource "oci_core_route_table" "private" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id

  route_rules {
    network_entity_id = oci_core_nat_gateway.nat.id
    destination       = "0.0.0.0/0"
  }
}

resource "oci_core_security_list" "workers" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_network_security_group" "db" {
  compartment_id = oci_identity_compartment.platform.id
  vcn_id         = oci_core_vcn.main.id
}

resource "oci_core_subnet" "lb" {
  compartment_id    = oci_identity_compartment.platform.id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.40.0.0/24"
  route_table_id    = oci_core_route_table.public.id
}

resource "oci_core_subnet" "api" {
  compartment_id    = oci_identity_compartment.platform.id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.40.1.0/24"
  route_table_id    = oci_core_route_table.private.id
}

resource "oci_core_subnet" "workers" {
  compartment_id    = oci_identity_compartment.platform.id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.40.16.0/20"
  route_table_id    = oci_core_route_table.private.id
  security_list_ids = [oci_core_security_list.workers.id]
}

resource "oci_core_subnet" "db" {
  compartment_id    = oci_identity_compartment.platform.id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.40.2.0/24"
  route_table_id    = oci_core_route_table.private.id
}

resource "oci_containerengine_cluster" "oke" {
  compartment_id     = oci_identity_compartment.platform.id
  kubernetes_version = var.k8s_version
  name               = "oke-${var.env}"
  vcn_id             = oci_core_vcn.main.id

  endpoint_config {
    subnet_id            = oci_core_subnet.api.id
    is_public_ip_enabled = false
  }
}

resource "oci_containerengine_node_pool" "general" {
  cluster_id         = oci_containerengine_cluster.oke.id
  compartment_id     = oci_identity_compartment.platform.id
  kubernetes_version = var.k8s_version
  name               = "general"
  node_shape         = "VM.Standard.E4.Flex"

  initial_node_labels {
    key   = "workload"
    value = "general"
  }

  node_config_details {
    size = var.nodes

    placement_configs {
      availability_domain = var.availability_domain
      subnet_id           = oci_core_subnet.workers.id
    }
  }
}

resource "oci_containerengine_node_pool" "batch" {
  count              = var.enable_batch_pool ? 1 : 0
  cluster_id         = oci_containerengine_cluster.oke.id
  compartment_id     = oci_identity_compartment.platform.id
  kubernetes_version = var.k8s_version
  name               = "batch"
  node_shape         = "VM.Standard.E4.Flex"

  initial_node_labels {
    key   = "workload"
    value = "batch"
  }

  node_config_details {
    size = 2

    placement_configs {
      availability_domain = var.availability_domain
      subnet_id           = oci_core_subnet.workers.id
    }
  }
}

resource "oci_core_instance" "bastion" {
  compartment_id      = oci_identity_compartment.platform.id
  availability_domain = var.availability_domain
  shape               = "VM.Standard.E4.Flex"

  create_vnic_details {
    subnet_id = oci_core_subnet.api.id
  }
}

resource "oci_load_balancer_load_balancer" "lb" {
  compartment_id = oci_identity_compartment.platform.id
  display_name   = "lb-${var.env}"
  shape          = "flexible"
  subnet_ids     = [oci_core_subnet.lb.id]
}

resource "oci_mysql_mysql_db_system" "mysql" {
  compartment_id      = oci_identity_compartment.platform.id
  availability_domain = var.availability_domain
  shape_name          = var.mysql_shape
  subnet_id           = oci_core_subnet.db.id
}

resource "oci_database_autonomous_database" "adw" {
  count          = var.enable_adb ? 1 : 0
  compartment_id = oci_identity_compartment.platform.id
  db_name        = "adw${var.env}"
  db_workload    = "DW"
}

resource "oci_objectstorage_bucket" "assets" {
  compartment_id = oci_identity_compartment.platform.id
  namespace      = var.os_namespace
  name           = "assets-${var.env}"
}

resource "oci_kms_vault" "vault" {
  compartment_id = oci_identity_compartment.platform.id
  display_name   = "vault-${var.env}"
  vault_type     = "DEFAULT"
}

resource "oci_identity_dynamic_group" "workers" {
  compartment_id = var.tenancy_ocid
  name           = "oke-workers"
  description    = "OKE worker instances"
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.platform.id}'}"
}

resource "oci_identity_policy" "oke" {
  compartment_id = oci_identity_compartment.platform.id
  name           = "oke-workers-policy"
  description    = "Workers may read the vault"
  statements     = ["Allow dynamic-group ${oci_identity_dynamic_group.workers.name} to read secret-family in compartment id ${oci_identity_compartment.platform.id}"]
}

resource "oci_dns_zone" "main" {
  compartment_id = oci_identity_compartment.platform.id
  name           = "sample.example.com"
  zone_type      = "PRIMARY"
}

resource "oci_dns_rrset" "app" {
  zone_name_or_id = oci_dns_zone.main.id
  domain          = "app.sample.example.com"
  rtype           = "A"
  items {
    domain = "app.sample.example.com"
    rtype  = "A"
    rdata  = oci_load_balancer_load_balancer.lb.ip_address_details[0].ip_address
    ttl    = 300
  }
}
