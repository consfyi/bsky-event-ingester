import {
  configureOAuth,
  createAuthorizationUrl,
  deleteStoredSession,
  finalizeAuthorization,
  getSession,
  listStoredSessions,
  resolveFromIdentity,
  resolveFromService,
  Session,
} from "@atcute/oauth-browser-client";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Avatar,
  Box,
  Button,
  Center,
  ColorSchemeScript,
  Container,
  createTheme,
  Group,
  Image,
  Loader,
  LoadingOverlay,
  MantineProvider,
  Menu,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import "@mantine/core/styles.css";
import { LinksFunction } from "@remix-run/node";
import {
  Link,
  Links,
  Meta,
  MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import {
  IconAt,
  IconBrandBluesky,
  IconChevronDown,
  IconLogout2,
} from "@tabler/icons-react";
import { Suspense, useEffect, useRef, useState } from "react";
import clientMetadata from "../public/client-metadata.json";
import { Client } from "./bluesky";
import LinguiProvider from "./components/LinguiProvider";
import { ClientContext } from "./contexts";
import { useClient, useSelf, useSelfFollows } from "./hooks";
import LocalAttendingContextProvider from "./components/LocalAttendingContextProvider";
import { SWRConfig } from "swr";

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

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  {
    name: "description",
    content: "Which furry conventions are you going to?",
  },
];

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [pending, setIsPending] = useState(false);

  const { t } = useLingui();
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
        zIndex: "var(--mantine-z-index-app)",
      }}
    >
      <Container size="lg" p="sm">
        <Group justify="space-between" wrap="nowrap">
          <Anchor<typeof Link>
            component={Link}
            to="/"
            aria-label={clientMetadata.client_name}
          >
            <Group gap={7}>
              <Image
                src="/logo.png"
                h={26}
                w={26}
                alt={clientMetadata.client_name}
              />
              <Text fw={500} size="lg" lh={1} visibleFrom="xs">
                {clientMetadata.client_name}
              </Text>
            </Group>
          </Anchor>
          {!selfIsLoading ? (
            self != null ? (
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
                  <UnstyledButton aria-label={`@${self.handle}`}>
                    <Group gap={7} wrap="nowrap">
                      <Box pos="relative">
                        <LoadingOverlay
                          visible={selfFollowsIsLoading}
                          loaderProps={{ size: "sm" }}
                        />
                        <Avatar
                          src={self.avatar}
                          alt={`@${self.handle}`}
                          size="sm"
                        />
                      </Box>
                      <Text fw={500} size="sm" lh={1} mr={3} visibleFrom="xs">
                        @{self.handle}
                      </Text>
                      <IconChevronDown size={14} />
                    </Group>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Button
                    fullWidth
                    loading={pending}
                    color="red"
                    variant="subtle"
                    leftSection={<IconLogout2 size={18} />}
                    onClick={() => {
                      setIsPending(true);
                      setMenuOpen(true);

                      (async () => {
                        try {
                          await client.signOut();
                        } catch (e) {
                          if (client.did != null) {
                            deleteStoredSession(client.did);
                          }
                        }
                        window.location.replace(window.location.toString());
                      })();
                    }}
                  >
                    Log out
                  </Button>
                </Menu.Dropdown>
              </Menu>
            ) : (
              <form
                onSubmit={(evt) => {
                  evt.preventDefault();

                  setIsPending(true);

                  (async () => {
                    let identity = undefined;
                    let metadata;

                    if (handle != "") {
                      const resp = await resolveFromIdentity(handle);
                      identity = resp.identity;
                      metadata = resp.metadata;
                    } else {
                      const resp = await resolveFromService(
                        "https://bsky.social"
                      );
                      metadata = resp.metadata;
                    }
                    const authUrl = await createAuthorizationUrl({
                      identity,
                      metadata,
                      scope: "atproto transition:generic",
                    });
                    window.location.assign(authUrl);
                  })();
                }}
              >
                <Button.Group my={-2}>
                  <Button
                    loading={pending}
                    type="submit"
                    size="xs"
                    leftSection={<IconBrandBluesky size={18} />}
                  >
                    <Trans>Log in</Trans>
                  </Button>
                  <Menu
                    position="bottom-end"
                    withArrow
                    withinPortal={false}
                    opened={menuOpen}
                    onChange={(value) => {
                      if (!value && pending) {
                        return;
                      }
                      setMenuOpen(value);
                    }}
                  >
                    <Menu.Target>
                      <Button size="xs" px={4} title={t`More log in options`}>
                        <IconChevronDown size={14} />
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
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
                    </Menu.Dropdown>
                  </Menu>
                </Button.Group>
              </form>
            )
          ) : null}
        </Group>
      </Container>
    </Box>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<Client | null>(null);

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
          <SWRConfig
            value={{
              suspense: true,
              revalidateOnFocus: false,
              revalidateOnReconnect: false,
            }}
          >
            <Suspense
              fallback={
                <Center p="lg">
                  <Loader />
                </Center>
              }
            >
              <LinguiProvider>
                {client != null ? (
                  <ClientContext.Provider value={client}>
                    <LocalAttendingContextProvider>
                      <Header />
                      <Container size="lg" px={0}>
                        <Suspense
                          fallback={
                            <Center p="lg">
                              <Loader />
                            </Center>
                          }
                        >
                          {children}
                        </Suspense>
                      </Container>
                    </LocalAttendingContextProvider>
                  </ClientContext.Provider>
                ) : (
                  <Center p="lg">
                    <Loader />
                  </Center>
                )}
              </LinguiProvider>
            </Suspense>
          </SWRConfig>
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
