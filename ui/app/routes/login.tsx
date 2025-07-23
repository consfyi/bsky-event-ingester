import { finalizeAuthorization } from "@atcute/oauth-browser-client";
import { configureOAuth } from "~/bluesky";
import { hookifyPromise } from "~/hooks";

const useLogin = (() => {
  let useLoginInternal: (() => void) | null = null;
  return () => {
    if (useLoginInternal == null) {
      useLoginInternal = hookifyPromise(
        (async () => {
          const params = new URLSearchParams(window.location.hash.slice(1));
          configureOAuth();

          try {
            await finalizeAuthorization(params);
          } catch (e) {
            // Do nothing.
          }

          window.location.replace("/");
        })()
      );
    }
    return useLoginInternal();
  };
})();

export default function Login() {
  useLogin();
  return null;
}
