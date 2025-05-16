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
  mantineHtmlProps,
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
} from "@mantine/core";
import {
  IconArrowBackUp,
  IconAt,
  IconChevronDown,
  IconEye,
  IconWorld,
} from "@tabler/icons-react";
import { useCallback, useContext, useEffect, useState } from "react";
import { CLIENT } from "./bluesky";
import { UserView, UserViewContext } from "./context";

const theme = createTheme({});

async function fetchUserView(actor: string): Promise<UserView> {
  const [profile, follows] = await Promise.all([
    CLIENT.getProfile(actor),
    (async () => {
      const follows = new Set<string>();
      for await (const follow of CLIENT.getFollows(actor)) {
        follows.add(follow.did);
      }
      return follows;
    })(),
  ]);
  const labels = await (async () => {
    const labels = new Set<string>();
    for await (const label of CLIENT.getLabels(profile.did)) {
      labels.add(label);
    }
    return labels;
  })();
  return { profile, follows, labels };
}

const VIEW_AS_LOCAL_STORAGE_KEY = "viewAs";

function Header() {
  const { userView, setUserView } = useContext(UserViewContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewAs, setViewAs] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const v = window.localStorage.getItem(VIEW_AS_LOCAL_STORAGE_KEY);
    if (v == null) {
      return;
    }

    setLoggingIn(true);
    setMenuOpen(false);

    (async () => {
      let userView = null;
      try {
        userView = await fetchUserView(v);
      } catch (e) {
        // Do nothing.
      }
      if (userView == null) {
        window.localStorage.removeItem(VIEW_AS_LOCAL_STORAGE_KEY);
      }
      setUserView(userView);
      setLoggingIn(false);
    })();
  }, [setUserView]);

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
        <Group justify="space-between">
          <Anchor<typeof Link> component={Link} to="/">
            <Text fw={500} size="lg">
              conlabels.furryli.st
            </Text>
          </Anchor>
          <Menu
            position="bottom-end"
            withArrow
            opened={menuOpen}
            onChange={(value) => {
              if (value && loggingIn) {
                return;
              }
              setMenuOpen(value);
            }}
          >
            <Menu.Target>
              <UnstyledButton>
                <Group gap={7}>
                  {userView != null ? (
                    <>
                      <Avatar src={userView.profile.avatar} size="sm" />
                      <Text fw={500} size="sm" lh={1} mr={3}>
                        {userView.profile.handle}
                      </Text>
                    </>
                  ) : loggingIn ? (
                    <>
                      <Text fw={500} size="sm" lh={1} c="dimmed">
                        <Loader size={18} color="dimmed" />
                      </Text>
                      <Text fw={500} size="sm" lh={1} mr={3} c="dimmed">
                        Please wait…
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text fw={500} size="sm" lh={1} c="dimmed">
                        <IconWorld />
                      </Text>
                      <Text fw={500} size="sm" lh={1} mr={3} c="dimmed">
                        Global view
                      </Text>
                    </>
                  )}
                  <IconChevronDown size={12} stroke={1.5} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {userView == null ? (
                <form
                  onSubmit={(evt) => {
                    evt.preventDefault();

                    setViewAs("");

                    setLoggingIn(true);
                    setMenuOpen(false);

                    (async () => {
                      let userView = null;
                      try {
                        userView = await fetchUserView(viewAs);
                      } catch (e) {
                        // Do nothing.
                      }
                      setUserView(userView);
                      setLoggingIn(false);
                    })();
                  }}
                >
                  <TextInput
                    disabled={loggingIn}
                    leftSection={<IconAt size={16} />}
                    placeholder="handle.bsky.social"
                    value={viewAs}
                    onChange={(e) => {
                      setViewAs(e.target.value);
                    }}
                  />
                  <Button
                    disabled={loggingIn}
                    type="submit"
                    fullWidth
                    mt={4}
                    leftSection={<IconEye size={18} />}
                  >
                    View as
                  </Button>
                </form>
              ) : (
                <Button
                  fullWidth
                  color="red"
                  variant="subtle"
                  leftSection={<IconArrowBackUp size={18} />}
                  onClick={() => {
                    setMenuOpen(false);
                    setUserView(null);
                  }}
                >
                  Reset view
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
  const [userView, setUserView] = useState<UserView | null>(null);

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <UserViewContext.Provider
          value={{
            userView,
            setUserView: useCallback((value) => {
              setUserView(value);
              if (value != null) {
                window.localStorage.setItem(
                  VIEW_AS_LOCAL_STORAGE_KEY,
                  value.profile.did
                );
              } else {
                window.localStorage.removeItem(VIEW_AS_LOCAL_STORAGE_KEY);
              }
            }, []),
          }}
        >
          <MantineProvider theme={theme}>
            <Header />
            <Container size="lg" px={0}>
              {children}
            </Container>
          </MantineProvider>
        </UserViewContext.Provider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
