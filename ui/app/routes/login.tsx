import { finalizeAuthorization } from "@atcute/oauth-browser-client";
import { Center, Loader } from "@mantine/core";
import { useEffect } from "react";
import { configureOAuth } from "~/bluesky";

export default function Login() {
  useEffect(() => {
    (async () => {
      configureOAuth();

      const params = new URLSearchParams(window.location.hash.slice(1));
      try {
        await finalizeAuthorization(params);
      } catch (e) {
        // Do nothing.
      }

      window.location.replace("/");
    })();
  });

  return (
    <Center p="lg">
      <Loader />
    </Center>
  );
}
