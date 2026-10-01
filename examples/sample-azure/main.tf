# Synthetic Azure landing zone (invented names/values; no real data).

resource "azurerm_resource_group" "net" {
  name     = "rg-net-${var.env}"
  location = var.location
}

resource "azurerm_resource_group" "app" {
  name     = "rg-app-${var.env}"
  location = var.location
}

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name
  address_space       = ["10.10.0.0/16"]
}

resource "azurerm_virtual_network" "spoke" {
  name                = "vnet-spoke"
  location            = var.location
  resource_group_name = azurerm_resource_group.app.name
  address_space       = ["10.20.0.0/16"]
}

resource "azurerm_virtual_network_peering" "hub_to_spoke" {
  name                      = "hub-to-spoke"
  resource_group_name       = azurerm_resource_group.net.name
  virtual_network_name      = azurerm_virtual_network.hub.name
  remote_virtual_network_id = azurerm_virtual_network.spoke.id
}

resource "azurerm_subnet" "hub_mgmt" {
  name                 = "snet-mgmt"
  resource_group_name  = azurerm_resource_group.net.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_subnet" "spoke_aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.spoke.name
  address_prefixes     = ["10.20.0.0/20"]
}

resource "azurerm_subnet" "spoke_data" {
  name                 = "snet-data"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.spoke.name
  address_prefixes     = ["10.20.16.0/24"]

  delegation {
    name = "postgres"
    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
    }
  }
}

resource "azurerm_subnet" "spoke_pe" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.spoke.name
  address_prefixes     = ["10.20.17.0/24"]
}

resource "azurerm_network_security_group" "aks" {
  name                = "nsg-aks"
  location            = var.location
  resource_group_name = azurerm_resource_group.app.name
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.spoke_aks.id
  network_security_group_id = azurerm_network_security_group.aks.id
}

resource "azurerm_public_ip" "nat" {
  name                = "pip-nat"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "hub" {
  name                = "natgw-hub"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name
  sku_name            = "Standard"
}

resource "azurerm_nat_gateway_public_ip_association" "hub" {
  nat_gateway_id       = azurerm_nat_gateway.hub.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "hub" {
  subnet_id      = azurerm_subnet.hub_mgmt.id
  nat_gateway_id = azurerm_nat_gateway.hub.id
}

resource "azurerm_public_ip" "ingress" {
  name                = "pip-ingress"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_lb" "ingress" {
  name                = "lb-ingress"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name
  sku                 = "Standard"

  frontend_ip_configuration {
    name                 = "public"
    public_ip_address_id = azurerm_public_ip.ingress.id
  }
}

resource "azurerm_user_assigned_identity" "aks" {
  name                = "id-aks"
  location            = var.location
  resource_group_name = azurerm_resource_group.app.name
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = "aks-${var.env}"
  location            = var.location
  resource_group_name = azurerm_resource_group.app.name
  dns_prefix          = "aks-${var.env}"
  kubernetes_version  = var.aks_version

  default_node_pool {
    name           = "system"
    vm_size        = "Standard_D4s_v5"
    node_count     = var.system_nodes
    vnet_subnet_id = azurerm_subnet.spoke_aks.id

    only_critical_addons_enabled = true
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks.id]
  }

  network_profile {
    network_plugin = "azure"
    network_policy = "calico"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "user" {
  name                  = "user"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = var.user_vm_size
  min_count             = var.user_min
  max_count             = var.user_max
  auto_scaling_enabled  = true
  vnet_subnet_id        = azurerm_subnet.spoke_aks.id

  node_labels = {
    workload = "general"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "batch" {
  name                  = "batch"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = "Standard_D8s_v5"
  priority              = "Spot"
  eviction_policy       = "Delete"
  min_count             = 0
  max_count             = 10
  auto_scaling_enabled  = true
  vnet_subnet_id        = azurerm_subnet.spoke_aks.id

  node_labels = {
    workload = "batch"
  }

  node_taints = ["batch=true:NoSchedule"]
}

resource "azurerm_container_registry" "acr" {
  name                = "acrsample${var.env}"
  resource_group_name = azurerm_resource_group.app.name
  location            = var.location
  sku                 = "Premium"
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  # image pulls use the kubelet identity, not the control-plane identity
  principal_id         = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
}

resource "azurerm_postgresql_flexible_server" "pg" {
  name                   = "pg-${var.env}"
  resource_group_name    = azurerm_resource_group.app.name
  location               = var.location
  version                = "16"
  sku_name               = var.pg_sku
  storage_mb             = var.pg_storage_mb
  delegated_subnet_id    = azurerm_subnet.spoke_data.id
  administrator_login    = "pgadmin"
  administrator_password = var.pg_admin_password
}

resource "azurerm_mssql_server" "sql" {
  count                = var.enable_sql ? 1 : 0
  name                 = "sql-${var.env}"
  resource_group_name  = azurerm_resource_group.app.name
  location             = var.location
  version              = "12.0"
  administrator_login          = "sqladmin"
  administrator_login_password = var.sql_admin_password
}

resource "azurerm_mssql_database" "orders" {
  count     = var.enable_sql ? 1 : 0
  name      = "orders"
  server_id = azurerm_mssql_server.sql[0].id
  sku_name  = "S1"
}

resource "azurerm_redis_cache" "cache" {
  name                = "redis-${var.env}"
  resource_group_name = azurerm_resource_group.app.name
  location            = var.location
  capacity            = var.redis_capacity
  family              = "C"
  sku_name            = "Standard"
}

resource "azurerm_cosmosdb_account" "cosmos" {
  count               = var.enable_cosmos ? 1 : 0
  name                = "cosmos-${var.env}"
  resource_group_name = azurerm_resource_group.app.name
  location            = var.location
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }
}

resource "azurerm_key_vault" "kv" {
  name                = "kv-${var.env}"
  resource_group_name = azurerm_resource_group.app.name
  location            = var.location
  tenant_id           = var.tenant_id
  sku_name            = "standard"
}

resource "azurerm_private_endpoint" "kv" {
  name                = "pe-kv"
  resource_group_name = azurerm_resource_group.app.name
  location            = var.location
  subnet_id           = azurerm_subnet.spoke_pe.id

  private_service_connection {
    name                           = "kv"
    private_connection_resource_id = azurerm_key_vault.kv.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }
}

resource "azurerm_storage_account" "data" {
  name                     = "stsample${var.env}"
  resource_group_name      = azurerm_resource_group.app.name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "GRS"
}

resource "azurerm_network_interface" "bastion" {
  name                = "nic-bastion"
  location            = var.location
  resource_group_name = azurerm_resource_group.net.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.hub_mgmt.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "bastion" {
  name                  = "vm-bastion"
  resource_group_name   = azurerm_resource_group.net.name
  location              = var.location
  size                  = "Standard_B2s"
  admin_username        = "ops"
  network_interface_ids = [azurerm_network_interface.bastion.id]

  admin_ssh_key {
    username   = "ops"
    public_key = var.bastion_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
}

resource "azurerm_dns_zone" "main" {
  name                = "sample.example.com"
  resource_group_name = azurerm_resource_group.net.name
}

resource "azurerm_dns_a_record" "app" {
  name                = "app"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = azurerm_resource_group.net.name
  ttl                 = 300
  target_resource_id  = azurerm_public_ip.ingress.id
}
