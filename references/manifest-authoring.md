# Manifest authoring (Layer B)

One manifest per repo: `{ "repoId": "...", "rules": [...] }`. Schema: `schemas/manifest.schema.json`; enforced by `lib/manifest/validate-manifest.mjs`.

## Rule shapes

```json
{ "match": { "type": "aws_vpc" }, "entity": { "kind": "aws.vpc", "idFrom": "name" } }
{ "match": { "type": ["aws_subnet"], "nameRegex": "^private" }, "entity": { "kind": "aws.subnet.private", "idFrom": "address" } }
{ "match": { "type": "aws_eks_addon" }, "entity": { "kind": "aws.eks.addon", "idFrom": "name", "boundary": "aws.eks.cluster", "embed": true } }
{ "match": { "type": "aws_db_subnet_group" }, "ignore": true }
```

- `match` keys: `type` (string or list), `isData`, `modulePathPrefix`, `nameRegex` (against local name). At least one key.
- `entity`: `kind` (namespaced, `<provider>.<service>[.<variant>]`), `idFrom` = `name` | `address` | `literal` (+`id`), optional `boundary` (exact kind of the parent), optional `embed` (property of parent, not drawn).
- `ignore: true` (exclusive with `entity`): helper resources (IAM attachments, subnet groups, route associations) that must not count as unmapped.
- First match wins: put specific rules (variants, regexes) before generic ones.

## Checklist

1. List the distinct resource types in the DOT graph; each must end in an entity rule or an `ignore` rule.
2. Prefer a kind that already exists in `catalog/kinds.json`; if you need a new one, add it to the catalog (see catalog.md) instead of leaving it without placement.
3. Use `idFrom: "name"` unless names collide across modules; then `address`.
4. Do NOT set `boundary` when the parent can be inferred from references or the catalog; use it only when the kind of the parent is exact and unique in the repo.
5. Counted/indexed resources (`aws_subnet.private[0]`) become one entity each; choose `address` if ids would clash.
6. Run `node scripts/lint.mjs manifest.json`; fix errors, review warnings (shadowed rule, kind without catalog entry, boundary kind never produced).

## Cross-repo

Relations that Terraform does not express (e.g. EKS discovers subnets by tag) go in `crossRepoLinks` of the compile call: `{fromKind, toKind, label?, nest?}`. `nest: true` places `from` entities inside the single `to` entity; zero or several targets are reported, never guessed.
