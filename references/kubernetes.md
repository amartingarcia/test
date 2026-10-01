# Kubernetes layer

Input: rendered manifests (plain YAML, `helm template` output, `kustomize build` output, ArgoCD resources). Never raw Helm templates. The skill reads files only; it never talks to a cluster.

## Pipeline

1. `loadK8sManifests(files)` (`lib/k8s/load-manifests.mjs`): parse + flatten. Check `errors`: each unparseable file is listed with its line; fix or exclude the file, do not ignore.
2. `buildK8sGraph({ environment, clusterName, objects, view, nodeGroups })` (`lib/k8s/build-k8s-graph.mjs`), once per view:
   - `view: 'namespace'`: cluster > namespace > workloads/services/ingress/config; ArgoCD apps and appsets inside their namespace.
   - `view: 'nodes'`: cluster > node pool (Karpenter NodePool or a node group passed in `nodeGroups`) > workloads.
3. Write each graph to `viewer/data/<id>.json` and register it in `environments.json` (see `scripts/build-k8s-sample.mjs`).

`nodeGroups` come from the cloud layer (EKS managed node groups from the Terraform graph: name, labels, taints). Without them, workloads that target them are reported as `none`.

## What is resolved, what is reported

- Placement in a pool needs exactly one compatible pool; otherwise it is `ambiguous` / `none` / `unknown` in `unresolvedPlacements` and the workload stays at cluster level.
- Application > managed objects only through the explicit tracking label `argocd.argoproj.io/instance` (or tracking-id annotation). No guessing by namespace.
- ApplicationSet: only the `list` generator is expanded; others are findings.
- Unknown kinds go to `coverage.k8s.unmapped`; add them to the loader/builder (and catalog) or accept them consciously.
- `findings`: references to missing ConfigMap/Secret/PVC/Service/EC2NodeClass, Services selecting no workload.

## Safety

Secret `data`/`stringData` are removed at load time. Real manifests and compiled data stay out of public repos; only `examples/sample-k8s` (synthetic) is committed.

## Model guidance

Same loop as the Terraform side: build, read `coverage`, `unresolvedPlacements`, `findings`, explain or fix each. Smaller models must not edit `scheduling.mjs` or the builder; if a pattern is unsupported, report it.
