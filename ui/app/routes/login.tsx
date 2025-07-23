import {
  configureOAuth,
  finalizeAuthorization,
} from "@atcute/oauth-browser-client";
import { Navigate } from "react-router";
import { hookifyPromise } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

const useLogin = (() => {
  let useLoginInternal: (() => void) | null = null;
  return () => {
    if (useLoginInternal == null) {
      useLoginInternal = hookifyPromise(
        (async () => {
          const params = new URLSearchParams(window.location.hash.slice(1));

          configureOAuth({
            metadata: {
              client_id: clientMetadata.client_id,
              redirect_uri: clientMetadata.redirect_uris[0],
            },
          });

          try {
            await finalizeAuthorization(params);
          } catch (e) {
            // Do nothing.
          }
        })()
      );
    }
    return useLoginInternal();
  };
})();

export default function Login() {
  useLogin();
  return <Navigate to="/" replace />;
}
