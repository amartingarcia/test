variable "env" { type = string }
variable "location" { type = string }
variable "tenant_id" { type = string }
variable "aks_version" { type = string }
variable "system_nodes" { type = number }
variable "user_vm_size" { type = string }
variable "user_min" { type = number }
variable "user_max" { type = number }
variable "pg_sku" { type = string }
variable "pg_storage_mb" { type = number }
variable "redis_capacity" { type = number }
variable "enable_sql" { type = bool }
variable "enable_cosmos" { type = bool }

variable "pg_admin_password" {
  type      = string
  sensitive = true
}

variable "sql_admin_password" {
  type      = string
  sensitive = true
}

variable "bastion_ssh_public_key" { type = string }
