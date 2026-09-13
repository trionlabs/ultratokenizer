# Public demo API gateway

The static app can reach the existing Node/Rust issuer service through a small
Worker and an authenticated loopback bridge. This adapter does not create a second
issuer, run proofs on Workers, or change document admission and spending rules.

```text
browser -> same-origin /api -> Worker -> HTTPS tunnel -> loopback bridge
                                                       -> existing issuer API
```

`worker.mjs` accepts only the existing document API routes. It forwards bodies
unchanged to one configured HTTPS origin and injects a gateway credential stored
as a Worker secret. `bridge.mjs` checks the credential with a constant-time
comparison, requires the configured loopback Host, validates the public Origin,
and translates it to the existing local service Origin. It serves no files and
never reads wallet keys. The original issuer service retains its holder-signature,
proof-budget, reservation, concurrency, and durable-job checks.

The gateway credential authenticates the Worker to the bridge. It does not
authorize public users to spend: source admission and the holder's signature
remain necessary for the original service's paid operation. Browser Origin is a
cross-origin browser control, not user authentication.

## Local configuration

Run the bridge from the repository root with one repository-relative path:

```sh
node packages/demo-service/hosting/main.mjs work/runtime/hedera-testnet/public-hosting/bridge.json
```

Prepare both JSON files in an ignored directory with mode 0700; files must be
owner-only (0600). The startup loader rejects symlinks, changed file hashes, a
different chain/policy, or a manifest with other than ten entries.

`bridge.json` has these exact fields:

```json
{
  "format": "ultratokenizer.public-bridge.v1",
  "publicOrigin": "https://demo.example.invalid",
  "port": 4176,
  "serviceConfigPath": "work/runtime/hedera-testnet/document-flow/service.json",
  "serviceConfigSha256": "REVIEWED_EXACT_SERVICE_FILE_SHA256",
  "deploymentSha256": "REVIEWED_EXACT_DEPLOYMENT_FILE_SHA256",
  "manifestSha256": "REVIEWED_EXACT_BATCH_TEN_MANIFEST_SHA256",
  "gatewayTokenPath": "work/runtime/hedera-testnet/public-hosting/gateway-secret.json"
}
```

`gateway-secret.json` has exactly `format: "ultratokenizer.gateway-secret.v1"`
and `token`, generated with `randomBytes(32).toString('hex')`. Never print this
value or place it in process arguments, static assets, source control, or a
browser-readable configuration. Load it from the file when populating the Worker
secret. Do not reuse a wallet private key or Cloudflare credential.

The three hashes cover the exact current service file and the deployment/manifest
files named by that service. The deployment must select Hedera testnet chain 296,
policy 2; the manifest must contain the existing ten reviewed synthetic runs.
Re-pinning requires an explicit review. This code does not admit another batch.

## Tunnel and Worker deployment

First verify the bridge rejects a request without the gateway credential. Never
tunnel directly to the original issuer API or the web preview server.

A named Cloudflare Tunnel can map a reviewed backend hostname to
`http://127.0.0.1:4176`, with `originRequest.httpHostHeader: 127.0.0.1:4176` and a
final 404 ingress rule. Cloudflare Access Service Auth can be added as another
boundary; supply both `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as Worker
secrets. The bridge still requires its own credential.

For a supervised presentation, an official Quick Tunnel is an alternative:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4176 --http-host-header 127.0.0.1:4176 --metrics 127.0.0.1:0
```

Use only the resulting HTTPS hostname as `DOCUMENT_SERVICE_ORIGIN`. Quick Tunnels
have no uptime guarantee and their hostname is temporary. The origin host and
both processes must remain available; this is not unattended production hosting.
Do not enable debug/header logging. If a default cloudflared configuration
interferes, use a separate reviewed config path rather than modifying another
tunnel's configuration. [Official Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

Copy `wrangler.example.jsonc` to a deployment-specific ignored config. Adjust its
relative `main` and assets paths for that config's location, retain the existing
site name/custom domain, and provide these bindings:

| Binding                                    | Kind             | Value                                          |
| ------------------------------------------ | ---------------- | ---------------------------------------------- |
| `ASSETS`                                   | Static assets    | The reviewed `apps/web/build` snapshot         |
| `PUBLIC_ORIGIN`                            | Variable         | The exact public app origin, no trailing slash |
| `DOCUMENT_SERVICE_ORIGIN`                  | Variable         | The exact fixed HTTPS tunnel origin            |
| `DOCUMENT_GATEWAY_TOKEN`                   | Secret           | Same random credential as the local file       |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Optional secrets | Both present or both absent                    |

Keep `assets.run_worker_first` set to `["/api", "/api/*"]`, so API failures are
JSON responses rather than a static HTML fallback. `workers_dev` and preview URLs
are disabled in the example. Generate Worker bindings and validate the reviewed
configuration before deployment. [Worker and static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

Use Wrangler's secret command with stdin supplied by a small local script that
reads the owner-only JSON; never interpolate the secret into shell text. Only
metadata (secret name and success/failure) may be printed. Review the exact Worker
route/configuration change before deploying it.

## Checks and limits

```sh
node --test packages/demo-service/test/public-gateway.test.mjs
npm run check:demo-service
```

The focused tests exercise both HTTP boundaries and every supported method/path,
unchanged request signatures, original service errors, missing/wrong credentials,
cross-origin calls, traversal, size limits, concurrency, stalled upstream data,
redirects, header stripping and pinned owner-only configuration. They are included
in the existing `check:demo-service` gate. They do not establish deployed Tunnel
availability, real proof fulfillment, or successful minting.

There are at most four active bridge requests, PDF bodies are limited to 256 KiB,
JSON requests to 16 KiB, responses to 160 KiB, and outbound work to 30 seconds.
The gateway does not retry a POST. A timed-out upstream operation may continue in
the existing durable service; recover its known job rather than making another
proof request. Fifty generated PDFs are not admitted by publishing this gateway.

After deployment, test health/config, a reviewed synthetic PDF, a denied foreign
document, a denied wrong-holder signature, and unauthenticated tunnel access. Do
not use a valid paid-start request as a connectivity test. Check the public
deployment pins still match the service. A presentation is complete only after
the actual proof, mint and receipt have been checked separately.

To withdraw public access, stop only the bridge/tunnel or remove the Worker API
route. Keep the original issuer service, job journal and proof budget intact.
