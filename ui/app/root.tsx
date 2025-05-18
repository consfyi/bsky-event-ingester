import { ResourceUri } from "@atcute/lexicons";
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
import { Trans } from "@lingui/react/macro";
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
import { useCallback, useEffect, useRef, useState } from "react";
import clientMetadata from "../public/client-metadata.json";
import { Client } from "./bluesky";
import { LinguiProvider } from "./components/LinguiProvider";
import { ClientContext, LocalAttendingContext } from "./contexts";
import {
  useClient,
  useConPosts,
  useCons,
  useSelf,
  useSelfFollows,
} from "./hooks";

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
                  <UnstyledButton>
                    <Group gap={7} wrap="nowrap">
                      <Box pos="relative">
                        <LoadingOverlay
                          visible={selfFollowsIsLoading}
                          loaderProps={{ size: "sm" }}
                        />
                        <Avatar src={self.avatar} size="sm" />
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
                      <Button size="xs" px={4}>
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
          <LinguiProvider
            loadingPlaceholder={
              <Center p="lg">
                <Loader />
              </Center>
            }
          >
            {client != null ? (
              <ClientContext.Provider value={client}>
                <InnerWithClient>{children}</InnerWithClient>
              </ClientContext.Provider>
            ) : (
              <Center p="lg">
                <Loader />
              </Center>
            )}
          </LinguiProvider>
        </MantineProvider>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

const PENDING = Symbol();

export function InnerWithClient({ children }: { children: React.ReactNode }) {
  const client = useClient();

  const [localIsAttending, setLocalIsAttending] = useState<
    Record<string, boolean>
  >({});

  const [likeUris, setLikeUris] = useState<
    Record<string, ResourceUri | typeof PENDING | null>
  >({});

  const { data: cons } = useCons();
  const { data: conPosts } = useConPosts();

  useEffect(() => {
    if (cons == null || conPosts == null) {
      return;
    }

    const attendingStates: Record<string, boolean> = {};
    const likeUris: Record<string, ResourceUri | typeof PENDING | null> = {};

    for (const con of cons) {
      const conPost = conPosts[con.rkey];
      if (conPost.viewer == null) {
        attendingStates[con.identifier] = false;
        continue;
      }

      attendingStates[con.identifier] = conPost.viewer.like != null;
      likeUris[con.identifier] = conPost.viewer.like ?? null;
    }
    setLocalIsAttending(attendingStates);
    setLikeUris(likeUris);
  }, [conPosts, cons, setLocalIsAttending, setLikeUris]);

  useEffect(() => {
    if (cons == null || conPosts == null) {
      return;
    }

    for (const con of cons) {
      (async (con) => {
        const id = con.identifier;

        if (likeUris[id] == PENDING) {
          return;
        }

        const conPost = conPosts[con.rkey];

        if (localIsAttending[id] && likeUris[id] == null) {
          setLikeUris((likeUris) => ({
            ...likeUris,
            [id]: PENDING,
          }));

          try {
            const r = await client.like(conPost.uri, conPost.cid);
            setLikeUris((likeUris) => ({ ...likeUris, [id]: r! }));
          } catch (e) {
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: null,
            }));
          }
        } else if (!localIsAttending[id] && likeUris[id] != null) {
          const likeUri = likeUris[id];
          setLikeUris((likeUris) => ({
            ...likeUris,
            [id]: PENDING,
          }));

          try {
            await client.unlike(likeUri);
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: null,
            }));
          } catch (e) {
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: likeUri,
            }));
          }
        }
      })(con);
    }
  }, [client, cons, conPosts, likeUris, localIsAttending, setLikeUris]);

  const getIsAttending = useCallback(
    (id: string) => localIsAttending[id] ?? false,
    [localIsAttending]
  );
  const setIsAttending = useCallback(
    (id: string, value: boolean) => {
      setLocalIsAttending((localIsAttending) => ({
        ...localIsAttending,
        [id]: value,
      }));
    },
    [setLocalIsAttending]
  );

  return (
    <LocalAttendingContext.Provider
      value={{
        getIsAttending,
        setIsAttending,
      }}
    >
      <Header />
      <Container size="lg" px={0}>
        {children}
      </Container>
    </LocalAttendingContext.Provider>
  );
}

export default function App() {
  return <Outlet />;
}
