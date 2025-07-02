import {
  DataProvider,
  useController,
  useLoading,
  useSuspense,
} from "@data-client/react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Collapse,
  ColorSchemeScript,
  Container,
  createTheme,
  DirectionProvider,
  DirectionProviderProps,
  Group,
  Image,
  Loader,
  mantineHtmlProps,
  MantineProvider,
  Menu,
  Select,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import "@mantine/core/styles.css";
import { useLocalStorage } from "@mantine/hooks";
import {
  completeNavigationProgress,
  NavigationProgress,
  startNavigationProgress,
} from "@mantine/nprogress";
import "@mantine/nprogress/styles.css";
import {
  IconAlertTriangle,
  IconBrandBluesky,
  IconChevronDown,
  IconLanguage,
  IconLogout2,
  IconMoon,
  IconPaw,
  IconSun,
} from "@tabler/icons-react";
import IntlLocale from "intl-locale-textinfo-polyfill";
import { Suspense, useEffect, useState } from "react";
import {
  Link,
  Links,
  LinksFunction,
  Meta,
  MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
  useRouteError,
} from "react-router";
import Avatar from "~/components/Avatar";
import clientMetadata from "../public/client-metadata.json";
import { DEFAULT_PDS_HOST, startLogin } from "./bluesky";
import { GlobalMemoProvider } from "./components/GlobalMemoContext";
import LinguiProvider, {
  AVAILABLE_LOCALES,
  INITIAL_LOCALE,
  useLinguiContext,
} from "./components/LinguiProvider";
import { LABELER_DID } from "./config";
import { useGetPreferences, usePutPreferences } from "./endpoints";
import { useClient, useHydrated, useIsLoggedIn, useSelf } from "./hooks";
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
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme();

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
          <Anchor
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
          <Group my={-8}>
            <Tooltip
              label={
                colorScheme == "light" ? (
                  <Trans>Dark mode</Trans>
                ) : (
                  <Trans>Light mode</Trans>
                )
              }
            >
              <ActionIcon
                variant="outline"
                size="sm"
                color="gray"
                w={36}
                h={36}
                onClick={() => {
                  setColorScheme(colorScheme == "light" ? "dark" : "light");
                }}
              >
                {colorScheme == "light" ? (
                  <IconMoon size={18} />
                ) : (
                  <IconSun size={18} />
                )}
              </ActionIcon>
            </Tooltip>
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
                      if (!usingDefaultPdsHost) {
                        setMenuOpen(true);
                        setLoginError(e);
                      }
                    } finally {
                      setIsPending(false);
                    }
                  })();
                }}
              >
                <Button.Group>
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
        </Group>
      </Container>
    </Box>
  );
}

function Footer() {
  const { i18n } = useLingui();
  const { setLocale, pending: localePending } = useLinguiContext();

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
          disabled={localePending}
          onChange={(value) => {
            if (value == null) {
              return;
            }
            setLocale(value);
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
      <Text size="xl" fw={500} mb="sm">
        <Trans>Not found</Trans>
      </Text>
      <Text>
        <Trans>The page you requested could not be found.</Trans>
      </Text>
    </Box>
  );
}

function LoadingIndicator() {
  const { state } = useNavigation();
  useEffect(() => {
    if (state === "idle") {
      completeNavigationProgress();
    } else {
      startNavigationProgress();
    }
  }, [state]);
  return <NavigationProgress />;
}

function Welcome() {
  const [closed, setClosed] = useLocalStorage({
    key: "fbl:welcome:closed",
    getInitialValueInEffect: false,
    defaultValue: false,
  });

  return (
    <Collapse in={!closed}>
      <Alert
        my={{ lg: "xs" }}
        mx={{ base: 0, lg: "xs" }}
        icon={<IconPaw />}
        title={<Trans>Welcome!</Trans>}
        onClose={() => {
          setClosed(true);
        }}
        withCloseButton
      >
        <Trans>
          <Text size="sm" mb="xs">
            This the website for the{" "}
            <Anchor
              href="https://bsky.app/profile/cons.furryli.st"
              target="_blank"
              rel="noreferrer"
            >
              <IconBrandBluesky size={12} /> @cons.furryli.st
            </Anchor>{" "}
            service. For the full experience, please log in. You’ll be able to:
          </Text>
          {/* Using the List component here is wacky, so we don't use it */}
          <ul
            style={{
              marginTop: 0,
              marginBottom: "var(--mantine-spacing-xs)",
              paddingLeft: "var(--mantine-spacing-xl)",
            }}
          >
            <li>
              Tell people which cons you’re going to (you can also do this by
              liking the con post on Bluesky).
            </li>
            <li>See who you follow is going to a con.</li>
          </ul>
          <Text size="sm" mb="xs">
            <strong>Note:</strong> If you’re using a self-hosted PDS, you’ll
            need to use the dropdown next to the Log in button to specify it.
          </Text>
          <Text size="sm">
            A huge thank you to{" "}
            <Anchor
              href="https://furrycons.com"
              target="_blank"
              rel="noreferrer"
            >
              FurryCons.com
            </Anchor>{" "}
            who provides all the data on conventions!
          </Text>
        </Trans>
      </Alert>
    </Collapse>
  );
}

function NotSubscribedToLabelerAlert() {
  const getPreferences = useGetPreferences();
  const preferences = useSuspense(getPreferences);

  const putPreferences = usePutPreferences();
  const ctrl = useController();

  const [doSubscribe, loading] = useLoading(async () => {
    // Refetch preferences, just so we don't clobber any preferences that may have changed in the meantime with our old preferences.
    const prefs = (await ctrl.fetch(getPreferences)).preferences!;

    let labelersPref = prefs.find(
      (pref) => pref.$type == "app.bsky.actor.defs#labelersPref"
    );
    if (labelersPref == null) {
      labelersPref = {
        $type: "app.bsky.actor.defs#labelersPref",
        labelers: [],
      };
      prefs.push(labelersPref);
    }
    labelersPref.labelers.push({ did: LABELER_DID });

    await ctrl.fetch(putPreferences, { preferences: prefs });
  }, [ctrl, preferences, putPreferences]);

  const subscribedToLabeler =
    preferences.preferences == null ||
    preferences.preferences.some(
      (preference) =>
        preference.$type == "app.bsky.actor.defs#labelersPref" &&
        preference.labelers.some((labeler) => labeler.did == LABELER_DID)
    );

  return (
    <Collapse in={!subscribedToLabeler}>
      <Alert
        my={{ lg: "xs" }}
        mx={{ base: 0, lg: "xs" }}
        icon={<IconAlertTriangle />}
        title={<Trans>Not subscribed to labeler</Trans>}
        color="yellow"
      >
        <Text size="sm" mb="xs">
          <Trans>
            You are currently not subscribed to the labeler. That means you
            won’t be able to see other people’s con labels on Bluesky.
          </Trans>
        </Text>
        <Button
          size="sm"
          color="yellow"
          loading={loading}
          onClick={() => {
            doSubscribe();
          }}
        >
          <Trans>Fix this for me</Trans>
        </Button>
      </Alert>
    </Collapse>
  );
}

function Alerts() {
  const isLoggedIn = useIsLoggedIn();

  return (
    <>
      {!isLoggedIn ? <Welcome /> : null}
      <NotSubscribedToLabelerAlert />
    </>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  useEffect(() => {
    if (navigator.userAgent.indexOf("iPhone") > -1) {
      document
        .querySelector("meta[name=viewport]")!
        .setAttribute(
          "content",
          "width=device-width, initial-scale=1, maximum-scale=1"
        );
    }
  }, []);

  return (
    // lang is set by LinguiProvider.
    // eslint-disable-next-line jsx-a11y/html-has-lang
    <html {...mantineHtmlProps}>
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
            <LoadingIndicator />
            {hydrated ? (
              <DirectionProvider
                initialDirection={
                  new IntlLocale(INITIAL_LOCALE).textInfo
                    .direction as DirectionProviderProps["initialDirection"]
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
                        <Alerts />
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
