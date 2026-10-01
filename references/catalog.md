# Catalog (`catalog/providers/*.json`)

One file per provider (`aws`, `azure`, `gcp`, `oci`, `k8s`) plus `common.json` for groups shared across providers (iam, secrets, storage). `loadCatalog` merges them; a kind or group defined twice fails the load. Kind names: `<provider>.<service>[.<variant>]`.

The knowledge of "what goes inside what", separate from any repo.

```json
"aws.eks.nodegroup": { "placement": { "parentKinds": ["aws.eks.cluster"] }, "axis": "row", "order": 10, "glyph": "nodegroup", "size": "chip" }
```

- Lookup: exact kind, then the longest dotted prefix (`aws.subnet.private` falls back to `aws.subnet`).
- `placement.parentKinds`: candidate parents in priority order. The first kind with candidates wins; the entity nests only if exactly one candidate exists, otherwise it is reported in `unresolvedPlacements`.
- `axis` (`row`|`column`): how the container lays out its children. `order`: position among siblings (ties by id).
- `group`: viewer-synthesized global container (e.g. `iam`, `ssm`) for kinds that belong to no VPC.
- `glyph`: icon key defined in `viewer/app.js` GLYPHS; `size: "chip"` for small workload entries.

## Adding knowledge

Add one entry per kind, only from facts you can verify (provider docs, reference tools such as InfraMap or Cartography after checking their licence). Never look things up at runtime. Validate with `node scripts/lint.mjs <manifest> ` (it also lints the catalog: unknown parent kinds, bad axis, non-numeric order).
