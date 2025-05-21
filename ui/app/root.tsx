import { Trans, useLingui } from "@lingui/react/macro";
import {
  ActionIcon,
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
  useRouteError,
} from "@remix-run/react";
import {
  IconAt,
  IconBrandBluesky,
  IconChevronDown,
  IconLogout2,
} from "@tabler/icons-react";
import { Suspense, useEffect, useState } from "react";
import clientMetadata from "../public/client-metadata.json";
import { startLogin } from "./bluesky";
import LinguiProvider from "./components/LinguiProvider";
import LocalAttendingContextProvider from "./components/LocalAttendingContextProvider";
import { useClient, useHydrated, useSelf } from "./hooks";
import { CacheProvider } from "@data-client/react";

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
  const self = useSelf();

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
          {self != null ? (
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
                      await client.logout();
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
                startLogin(handle != "" ? handle : null);
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
          )}
        </Group>
      </Container>
    </Box>
  );
}

function Footer() {
  return (
    <Box
      style={{
        borderTop: "1px solid var(--mantine-color-default-border)",
      }}
      mt="sm"
    >
      <Container
        size="lg"
        display="flex"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          flexDirection: "column",
        }}
        p="sm"
      >
        <Text c="dimmed" size="sm" mb="sm">
          <Trans>
            All furry convention data courtesy of the volunteers at{" "}
            <Anchor
              href="https://furrycons.com"
              target="_blank"
              rel="noreferrer"
            >
              FurryCons.com
            </Anchor>{" "}
            – thank you! Convention missing?{" "}
            <Anchor
              href="https://furrycons.com/calendar/new.php"
              target="_blank"
              rel="noreferrer"
            >
              Submit it here!
            </Anchor>
          </Trans>
        </Text>
        <Group gap={0} justify="flex-end" wrap="nowrap">
          <ActionIcon
            aria-label="Bluesky"
            component="a"
            href="https://bsky.app/profile/conlabels.furryli.st"
            target="_blank"
            rel="noreferrer"
            size="md"
            color="gray"
            variant="subtle"
          >
            <IconBrandBluesky size={18} stroke={1.5} />
          </ActionIcon>
        </Group>
      </Container>
    </Box>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useLingui();

  if (!(error instanceof Response)) {
    throw error;
  }

  if (error.status != 404) {
    throw error;
  }

  useEffect(() => {
    document.title = t`Not found`;
  }, [t]);

  return (
    <Box p={50} ta="center">
      <Text size="xl" fw={500}>
        <Trans>Not found</Trans>
      </Text>
      <Text mt="sm">
        <Trans>The page you requested could not be found.</Trans>
      </Text>
    </Box>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();

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
          {hydrated ? (
            <CacheProvider>
              <Suspense
                fallback={
                  <Center p="lg">
                    <Loader />
                  </Center>
                }
              >
                <LinguiProvider>
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
                    <Footer />
                  </LocalAttendingContextProvider>
                </LinguiProvider>
              </Suspense>
            </CacheProvider>
          ) : null}
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
