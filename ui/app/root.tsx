import { DataProvider } from "@data-client/react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Center,
  ColorSchemeScript,
  Container,
  createTheme,
  Direction,
  DirectionProvider,
  Group,
  Image,
  Loader,
  MantineProvider,
  Menu,
  Select,
  Text,
  TextInput,
} from "@mantine/core";
import "@mantine/core/styles.css";
import { useLocalStorage } from "@mantine/hooks";
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
  IconBrandBluesky,
  IconChevronDown,
  IconLanguage,
  IconLogout2,
} from "@tabler/icons-react";
import IntlLocale from "intl-locale-textinfo-polyfill";
import { Suspense, useEffect, useState } from "react";
import Avatar from "~/components/Avatar";
import clientMetadata from "../public/client-metadata.json";
import { DEFAULT_PDS_HOST, startLogin } from "./bluesky";
import { GlobalMemoProvider } from "./components/GlobalMemoContext";
import LinguiProvider, {
  AVAILABLE_LOCALES,
  INITIAL_LOCALE,
  useSetLocale,
} from "./components/LinguiProvider";
import { useClient, useHydrated, useSelf } from "./hooks";
import "./styles.css";

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
  const [pdsHost, setPdsHost] = useLocalStorage({
    key: "fbl:pdsHost",
    defaultValue: "",
    getInitialValueInEffect: false,
  });

  const realPdsHost =
    pdsHost != ""
      ? pdsHost.replace(/^(?!https:\/\/)/, "https://")
      : DEFAULT_PDS_HOST;

  const usingDefaultPdsHost = realPdsHost == DEFAULT_PDS_HOST;

  const [loginError, setLoginError] = useState<unknown | null>(null);
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
                <Button
                  my={-8}
                  variant="outline"
                  color="var(--mantine-color-dimmed)"
                  c="var(--mantine-color-text)"
                  leftSection={
                    <Avatar
                      src={self.avatar}
                      alt={`@${self.handle}`}
                      size="sm"
                    />
                  }
                  rightSection={<IconChevronDown size={14} />}
                >
                  <Text span size="sm" fw={500} visibleFrom="xs">
                    @{self.handle}
                  </Text>
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label hiddenFrom="xs">@{self.handle}</Menu.Label>
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
                  <Trans>Log out</Trans>
                </Button>
              </Menu.Dropdown>
            </Menu>
          ) : (
            <form
              onSubmit={(evt) => {
                evt.preventDefault();
                setIsPending(true);
                (async () => {
                  try {
                    await startLogin(realPdsHost);
                  } catch (e) {
                    setIsPending(false);
                    if (!usingDefaultPdsHost) {
                      setMenuOpen(true);
                      setLoginError(e);
                    }
                  }
                })();
              }}
            >
              <Button.Group my={-8}>
                <Button
                  loading={pending}
                  type="submit"
                  size="sm"
                  leftSection={<IconBrandBluesky size={18} />}
                  color={!usingDefaultPdsHost ? "#8338ec" : undefined}
                >
                  {!usingDefaultPdsHost ? (
                    <Trans>
                      Log in via {realPdsHost.replace(/^https?:\/\//, "")}
                    </Trans>
                  ) : (
                    <Trans>Log in</Trans>
                  )}
                </Button>
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
                    <Button
                      size="sm"
                      px={4}
                      title={t`Log in via custom PDS`}
                      color={!usingDefaultPdsHost ? "#8338ec" : undefined}
                    >
                      <IconChevronDown size={14} />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <TextInput
                      label={<Trans>Custom PDS</Trans>}
                      name="pds"
                      m={4}
                      w="300"
                      disabled={pending}
                      error={
                        loginError != null ? (
                          <Trans>
                            Couldn’t log in with this PDS. Is the URL correct?
                          </Trans>
                        ) : null
                      }
                      placeholder="https://your.pds.com"
                      value={pdsHost}
                      onChange={(e) => {
                        setPdsHost(e.target.value);
                        setLoginError(null);
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
  const { i18n } = useLingui();
  const setLocale = useSetLocale();

  return (
    <Box
      style={{
        borderTop: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Container
        size="lg"
        display="flex"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          textAlign: "center",
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
        <Group gap={8} justify="flex-end" wrap="nowrap" mb="sm">
          <ActionIcon
            aria-label="Bluesky"
            component="a"
            href="https://bsky.app/profile/cons.furryli.st"
            target="_blank"
            rel="noreferrer"
            size="md"
            color="gray"
            variant="subtle"
          >
            <IconBrandBluesky size={18} stroke={1.5} />
          </ActionIcon>
        </Group>
        <Select
          withCheckIcon={false}
          leftSection={<IconLanguage stroke={1.5} size={18} />}
          size="xs"
          mb="sm"
          value={i18n.locale}
          onChange={(value) => {
            setLocale(value!);
          }}
          data={AVAILABLE_LOCALES.map((locale) => ({
            value: locale,
            label: new Intl.DisplayNames(locale, { type: "language" }).of(
              locale
            )!,
          }))}
        />
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
    // lang is set by LinguiProvider.
    // eslint-disable-next-line jsx-a11y/html-has-lang
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <GlobalMemoProvider>
          <MantineProvider theme={theme} defaultColorScheme="auto">
            {hydrated ? (
              <DirectionProvider
                initialDirection={
                  (new IntlLocale(INITIAL_LOCALE).textInfo.direction as
                    | Direction
                    | undefined) ?? "ltr"
                }
              >
                <DataProvider>
                  <Suspense
                    fallback={
                      <Center p="lg">
                        <Loader />
                      </Center>
                    }
                  >
                    <LinguiProvider>
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
                    </LinguiProvider>
                  </Suspense>
                </DataProvider>
              </DirectionProvider>
            ) : null}
          </MantineProvider>
        </GlobalMemoProvider>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
