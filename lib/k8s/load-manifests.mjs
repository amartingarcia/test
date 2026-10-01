import { parseYamlDocuments, YamlError } from '../yaml/parse-yaml.mjs';

/**
 * Parses Kubernetes manifests (raw YAML, `helm template` output, ArgoCD
 * resources) into flat objects. Anything that cannot be parsed is reported in
 * `errors` with its file and line, never skipped silently.
 *
 * Secret payloads (`data`, `stringData`) are dropped here, at the entry
 * point, so they can never reach a compiled graph or a public repo.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {{ objects: K8sObject[], errors: { path: string, message: string }[] }}
 */
export function loadK8sManifests(files) {
  const objects = [];
  const errors = [];
  for (const file of files) {
    let docs;
    try {
      docs = parseYamlDocuments(file.content);
    } catch (err) {
      if (!(err instanceof YamlError)) throw err;
      errors.push({ path: file.path, message: err.message });
      continue;
    }
    docs.forEach((doc, index) => {
      for (const raw of flattenLists(doc)) {
        const obj = toObject(raw, file.path, index);
        if (obj) objects.push(obj);
        else if (typeof raw.apiVersion === 'string' && typeof raw.kind === 'string') {
          errors.push({ path: file.path, message: `${raw.kind} without metadata.name (generateName?) was skipped: it cannot be placed in a diagram` });
        }
      }
    });
  }
  return { objects, errors };
}

function flattenLists(doc) {
  if (!isObject(doc)) return [];
  if (typeof doc.kind === 'string' && doc.kind.endsWith('List') && Array.isArray(doc.items)) return doc.items.flatMap(flattenLists);
  return [doc];
}

function toObject(raw, path, docIndex) {
  if (typeof raw.apiVersion !== 'string' || typeof raw.kind !== 'string' || !isObject(raw.metadata) || typeof raw.metadata.name !== 'string') return null;
  const { data, stringData, binaryData, ...rest } = raw;
  void data; void stringData; void binaryData;
  return {
    apiVersion: raw.apiVersion,
    kind: raw.kind,
    name: raw.metadata.name,
    namespace: typeof raw.metadata.namespace === 'string' ? raw.metadata.namespace : null,
    labels: isObject(raw.metadata.labels) ? raw.metadata.labels : {},
    annotations: isObject(raw.metadata.annotations) ? raw.metadata.annotations : {},
    spec: rest.spec ?? null,
    source: { path, doc: docIndex },
  };
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @typedef {{apiVersion: string, kind: string, name: string, namespace: string|null, labels: object, annotations: object, spec: any, source: {path: string, doc: number}}} K8sObject */
