import { useController, useLoading, useSuspense } from "@data-client/react";
import { Trans } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Button,
  Center,
  Collapse,
  Loader,
  Text,
} from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import {
  IconAlertTriangle,
  IconBrandBluesky,
  IconPaw,
} from "@tabler/icons-react";
import { Suspense } from "react";
import ConsList from "~/components/ConsList";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { useGetPreferences, usePutPreferences } from "~/endpoints";
import { useCons, useIsLoggedIn } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  { title: clientMetadata.client_name },
];

export default function Index() {
  const isLoggedIn = useIsLoggedIn();

  const cons = useCons();

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
    <>
      {!isLoggedIn ? (
        <Alert
          mt={{ lg: "xs" }}
          mx={{ base: 0, lg: "xs" }}
          icon={<IconPaw />}
          title={<Trans>Welcome!</Trans>}
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
              service. For the full experience, please log in. You’ll be able
              to:
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
      ) : null}
      <Collapse in={!subscribedToLabeler}>
        <Alert
          my={{ lg: "xs" }}
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
      <SimpleErrorBoundary>
        <Suspense
          fallback={
            <Center p="lg">
              <Loader />
            </Center>
          }
        >
          <ConsList cons={cons} />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
