import { proxy as dashboardProxy } from "./dashboardGuard";

export default async function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  // Node Proxy clones and drains POST bodies before invoking the route. A Mouse
  // result is a live upload: let its own bearer-token/disabled-node checks run
  // immediately instead of waiting for the model to finish generating.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/mouses/tunnel/result(?:/)?$).*)"],
};
