#!/bin/bash
# deploy/k8s on a kind cluster on this machine (docs/server.md, Trying it on kind): Calico, which enforces
# the NetworkPolicies, the two images built and loaded, deploy/k8s applied as it is with the Secrets it
# leaves to you, a Postgres for the service's replicas, and a fake model provider in place of a real one,
# so no task reaches a model API or spends anything. Then a task through the router, and what a task's pod can
# reach. Needs docker, kind and kubectl. From the repository's root:
#   deploy/kind.sh        make the cluster (or use the one there), deploy, try
#   deploy/kind.sh down   delete the cluster
# BUILD=0 uses the images as they are, and LOAD names more images to load into the node (for a node that
# can't pull them itself).
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=${CLUSTER:-jig}
CALICO=v3.29.3
IMAGES="registry.example.com/jig-worker:0.1.0 registry.example.com/jig-server:0.1.0"
KEY=kind-key
k() { kubectl --context "kind-$CLUSTER" "$@"; }
if [ "${1:-}" = down ]; then exec kind delete cluster --name "$CLUSTER"; fi

if ! kind get clusters | grep -qx "$CLUSTER"; then
  # No kindnet: its NetworkPolicy needs the kernel's nft queue, which not every kernel has. A process may
  # lower its oom_score_adj only with CAP_SYS_RESOURCE, which some machines' root lacks: containerd then
  # keeps the pods' no lower than its own, as in rootless kind.
  kind create cluster --name "$CLUSTER" --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri"]
      restrict_oom_score_adj = true
EOF
fi
if [ "${BUILD:-1}" != 0 ]; then
  docker build -f deploy/Dockerfile.worker -t registry.example.com/jig-worker:0.1.0 .
  docker build -f deploy/Dockerfile.server -t registry.example.com/jig-server:0.1.0 .
fi
for image in $IMAGES ${LOAD:-}; do
  # kind load fails on Docker's containerd image store (a multi-platform index): one platform's, then.
  kind load docker-image --name "$CLUSTER" "$image" 2>/dev/null ||
    docker save --platform "linux/$(docker version -f '{{.Server.Arch}}')" "$image" | docker exec -i "$CLUSTER-control-plane" ctr -n k8s.io images import --snapshotter=overlayfs - >/dev/null
done
k get daemonset -n kube-system calico-node >/dev/null 2>&1 ||
  curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/$CALICO/manifests/calico.yaml" | sed 's#docker.io/calico/#quay.io/calico/#' | k apply -f - >/dev/null
k -n kube-system rollout status daemonset/calico-node --timeout=300s

# deploy/k8s, then what it leaves to you.
k apply -f deploy/k8s/namespace.yaml
k apply -f deploy/k8s/
k -n jig get secret jig-secrets >/dev/null 2>&1 || k -n jig create secret generic jig-secrets --from-literal=gateway-secret="$(openssl rand -hex 32)"
k -n jig create secret generic jig-database --from-literal=url=postgres://jig:kind@postgres.jig.svc:5432/jig --dry-run=client -o yaml | k apply -f -
k -n jig create secret generic jig-provider-keys --from-literal=DEEPSEEK_API_KEY=not-a-key --dry-run=client -o yaml | k apply -f -
# The fake provider: a bash call with the prompt's text after "run: ", then "done" and the call's output; a
# line of text for any other prompt.
k -n jig create configmap fake-provider --dry-run=client -o yaml --from-file=provider.mjs=/dev/stdin <<'EOF' | k apply -f -
import { createServer } from "node:http";
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const block = (index, start, delta) => event("content_block_start", { index, content_block: start }) + event("content_block_delta", { index, delta }) + event("content_block_stop", { index });
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk)).on("end", () => {
    const { messages } = JSON.parse(body || "{}");
    const first = messages?.[0]?.content;
    const prompt = typeof first === "string" ? first : (first ?? []).map((part) => part.text ?? "").join("");
    const result = [messages?.at(-1)?.content].flat().find((part) => part?.type === "tool_result");
    const run = !result && /run: (.*)/s.exec(prompt);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(event("message_start", { message: { id: "m", type: "message", role: "assistant", model: "fake", content: [], usage: { input_tokens: 10, output_tokens: 1 } } }));
    if (run) res.write(block(0, { type: "tool_use", id: `call_${Date.now()}`, name: "bash", input: {} }, { type: "input_json_delta", partial_json: JSON.stringify({ command: run[1] }) }));
    else res.write(block(0, { type: "text", text: "" }, { type: "text_delta", text: result ? `done: ${JSON.stringify(result.content)}` : "hello from the fake provider" }));
    res.end(event("message_delta", { delta: { stop_reason: run ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } }) + event("message_stop", {}));
  });
}).listen(8099);
EOF
k apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: postgres, namespace: jig}
spec:
  selector: {matchLabels: {app: postgres}}
  template:
    metadata: {labels: {app: postgres}}
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env: [{name: POSTGRES_USER, value: jig}, {name: POSTGRES_PASSWORD, value: kind}, {name: POSTGRES_DB, value: jig}]
          readinessProbe: {exec: {command: [pg_isready, -U, jig]}}
---
apiVersion: v1
kind: Service
metadata: {name: postgres, namespace: jig}
spec: {selector: {app: postgres}, ports: [{port: 5432}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: fake-provider, namespace: jig}
spec:
  selector: {matchLabels: {app: fake-provider}}
  template:
    metadata: {labels: {app: fake-provider}}
    spec:
      containers:
        - name: provider
          image: registry.example.com/jig-server:0.1.0
          command: [node, /fake/provider.mjs]
          volumeMounts: [{name: code, mountPath: /fake}]
      volumes: [{name: code, configMap: {name: fake-provider}}]
---
apiVersion: v1
kind: Service
metadata: {name: fake-provider, namespace: jig}
spec: {selector: {app: fake-provider}, ports: [{port: 8099}]}
EOF
# The configs as deploy/k8s has them but for a tenant ("acme corp", whose key is kind-key), the gateway's
# provider (the fake), and the router's one region (this service). SERVICE adds to the service's config:
# SERVICE='{"kubernetes": {"image": "registry.example.com/jig-worker:0.1.0", "pool": {"size": 1}}}', say.
k -n jig get configmap jig-config jig-gateway-config jig-router-config -o json | KEY=$KEY SERVICE=${SERVICE:-'{}'} node -e '
  const list = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const keys = [require("node:crypto").createHash("sha256").update(process.env.KEY).digest("hex")];
  const extra = JSON.parse(process.env.SERVICE);
  const change = { "service.json": (c) => ({ ...c, ...extra, region: "kind", tenants: [{ id: "acme corp", keys, timeLimit: 600 }], kubernetes: { ...c.kubernetes, ...extra.kubernetes } }),
    "gateway.json": (c) => ({ ...c, upstream: { ...c.upstream, baseUrl: "http://fake-provider.jig.svc:8099/anthropic" } }),
    "router.json": (c) => ({ ...c, regions: [{ name: "kind", url: "http://jig-api.jig.svc:8080" }], tenants: [{ id: "acme corp", keys, home: "kind" }] }) };
  for (const map of list.items) for (const file of Object.keys(map.data)) map.data[file] = JSON.stringify(change[file](JSON.parse(map.data[file])), null, 2);
  for (const map of list.items) delete map.metadata.resourceVersion;
  console.log(JSON.stringify(list));' | k apply -f -
k -n jig rollout restart deployment jig-api jig-gateway jig-router fake-provider
for deployment in postgres fake-provider jig-redis jig-gateway jig-api jig-router; do k -n jig rollout status "deployment/$deployment" --timeout=300s; done

# A task through the router, and its events.
k -n jig port-forward service/jig-router 18090:8090 >/dev/null &
forward=$!
trap 'kill $forward' EXIT
for i in $(seq 1 30); do curl -fs localhost:18090/healthz >/dev/null && break; sleep 1; done
task=$(curl -fsS localhost:18090/v1/tasks -H "Authorization: Bearer $KEY" -d '{"prompt": "run: echo hello from $(hostname)"}' | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).id')
echo "task $task"
curl -fsSN "localhost:18090/v1/tasks/$task/events" -H "Authorization: Bearer $KEY" | grep '^data:'

# What a pod labelled as a task's reaches: the gateway, the service's internal listener and DNS alone.
k -n jig delete pod reach --ignore-not-found >/dev/null
k -n jig run reach --restart=Never --image=registry.example.com/jig-worker:0.1.0 \
  --labels=app.kubernetes.io/name=jig,app.kubernetes.io/component=task --command -- node -e '
  const targets = ["jig-gateway:8081", "jig-api-internal:8082", "jig-api:8080", "jig-redis:6379", "postgres:5432", "fake-provider:8099", "1.1.1.1:443"];
  for (const target of targets) {
    const [host, port] = target.split(":");
    const socket = require("node:net").connect(Number(port), host);
    const timer = setTimeout(() => (socket.destroy(), console.log(target, "blocked")), 3000);
    socket.on("connect", () => (clearTimeout(timer), socket.destroy(), console.log(target, "reached")));
    socket.on("error", (err) => (clearTimeout(timer), console.log(target, err.code)));
  }' >/dev/null
k -n jig wait --for=jsonpath='{.status.phase}'=Succeeded pod/reach --timeout=120s >/dev/null
k -n jig logs reach
k -n jig delete pod reach >/dev/null
