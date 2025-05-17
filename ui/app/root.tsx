import {
  Links,
  Link,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

import "@mantine/core/styles.css";

import {
  createTheme,
  MantineProvider,
  ColorSchemeScript,
  Container,
  Box,
  Text,
  Group,
  Anchor,
  Menu,
  UnstyledButton,
  Button,
  TextInput,
  Loader,
  Avatar,
  Center,
  Image,
  LoadingOverlay,
} from "@mantine/core";
import {
  IconAt,
  IconBrandBluesky,
  IconChevronDown,
  IconLogout2,
  IconUser,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  configureOAuth,
  resolveFromIdentity,
  createAuthorizationUrl,
  finalizeAuthorization,
  deleteStoredSession,
  listStoredSessions,
  getSession,
  Session,
} from "@atcute/oauth-browser-client";
import { useClient, useSelf, useSelfFollows } from "./hooks";
import { ClientContext } from "./context";
import { Client } from "./bluesky";

import clientMetadata from "../public/client-metadata.json";
import { LinksFunction } from "@remix-run/node";

const theme = createTheme({});

export const links: LinksFunction = () => {
  return [
    {
      rel: "icon",
      href: "/logo.png",
      type: "image/png",
    },
  ];
};

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [pending, setIsPending] = useState(false);

  const client = useClient();
  const { data: self, isLoading: selfIsLoading } = useSelf();
  const { isLoading: selfFollowsIsLoading } = useSelfFollows();

  return (
    <Box
      style={{
        background: "var(--mantine-color-body)",
        borderBottom: "1px solid var(--mantine-color-default-border)",
        position: "sticky",
        top: "0px",
        zIndex: 200,
      }}
    >
      <Container size="lg" p="sm">
        <Group justify="space-between" wrap="nowrap">
          <Anchor<typeof Link> component={Link} to="/">
            <Group gap={7}>
              <Image src="/logo.png" h={26} w={26} />
              <Text fw={500} size="lg" lh={1} visibleFrom="xs">
                {clientMetadata.client_name}
              </Text>
            </Group>
          </Anchor>
          <Menu
            position="bottom-end"
            withArrow
            opened={menuOpen}
            onChange={(value) => {
              if (!value && pending) {
                return;
              }
              setMenuOpen(value);
            }}
          >
            <Menu.Target>
              <UnstyledButton>
                <Group gap={7} wrap="nowrap">
                  {self != null ? (
                    <>
                      <Box pos="relative">
                        <LoadingOverlay
                          visible={selfFollowsIsLoading}
                          loaderProps={{ size: "sm" }}
                        />
                        <Avatar src={self.avatar} size="sm" />
                      </Box>
                      <Text fw={500} size="sm" lh={1} mr={3} visibleFrom="xs">
                        {self.handle}
                      </Text>
                    </>
                  ) : selfIsLoading ? (
                    <>
                      <Text fw={500} size="sm" lh={1} c="dimmed">
                        <Loader size={18} color="dimmed" />
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text fw={500} size="sm" lh={1} c="dimmed">
                        <IconUser />
                      </Text>
                      <Text
                        fw={500}
                        size="sm"
                        lh={1}
                        mr={3}
                        c="dimmed"
                        visibleFrom="xs"
                      >
                        Not logged in
                      </Text>
                    </>
                  )}
                  <IconChevronDown size={12} stroke={1.5} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {self == null && !selfIsLoading ? (
                <form
                  onSubmit={(evt) => {
                    evt.preventDefault();

                    setIsPending(true);
                    setMenuOpen(true);

                    (async () => {
                      const { identity, metadata } = await resolveFromIdentity(
                        handle
                      );

                      const authUrl = await createAuthorizationUrl({
                        metadata,
                        identity,
                        scope: "atproto transition:generic",
                      });

                      window.location.assign(authUrl);
                    })();
                  }}
                >
                  <TextInput
                    name="username"
                    disabled={pending}
                    leftSection={<IconAt size={16} />}
                    placeholder="handle.bsky.social"
                    value={handle}
                    onChange={(e) => {
                      setHandle(e.target.value);
                    }}
                  />
                  <Button
                    disabled={pending}
                    type="submit"
                    fullWidth
                    mt={4}
                    leftSection={
                      pending ? (
                        <Loader size={18} color="dimmed" />
                      ) : (
                        <IconBrandBluesky size={18} />
                      )
                    }
                  >
                    Log in with Bluesky
                  </Button>
                </form>
              ) : (
                <Button
                  fullWidth
                  disabled={pending}
                  color="red"
                  variant="subtle"
                  leftSection={
                    pending ? (
                      <Loader size={18} color="dimmed" />
                    ) : (
                      <IconLogout2 size={18} />
                    )
                  }
                  onClick={() => {
                    setIsPending(true);
                    setMenuOpen(true);

                    (async () => {
                      try {
                        await client!.signOut();
                      } catch (e) {
                        if (client!.did != null) {
                          deleteStoredSession(client!.did);
                        }
                      }
                      window.location.replace(window.location.toString());
                    })();
                  }}
                >
                  Log out
                </Button>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Container>
    </Box>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<Client | null>(null);
  const { isLoading: selfIsLoading } = useSelf();

  const ready = useRef(false);

  useEffect(() => {
    if (!ready.current) {
      ready.current = true;
      const params = new URLSearchParams(location.hash.slice(1));
      window.history.replaceState(
        null,
        "",
        location.pathname + location.search
      );

      configureOAuth({
        metadata: {
          client_id: clientMetadata.client_id,
          redirect_uri: clientMetadata.redirect_uris[0],
        },
      });

      (async () => {
        let session: Session | null = null;
        if (params.size > 0) {
          try {
            session = await finalizeAuthorization(params);
          } catch (e) {
            // Do nothing.
          }
        } else {
          const sessions = listStoredSessions();
          if (sessions.length > 0) {
            const did = sessions[0];
            try {
              session = await getSession(did, { allowStale: false });
            } catch (e) {
              deleteStoredSession(did);
            }
          }
        }
        setClient(new Client(session));
      })();
    }
  }, [setClient]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {client != null || selfIsLoading ? (
            <ClientContext.Provider value={client}>
              <Header />
              <Container size="lg" px={0}>
                {children}
              </Container>
            </ClientContext.Provider>
          ) : (
            <Center p="lg">
              <Loader />
            </Center>
          )}
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
