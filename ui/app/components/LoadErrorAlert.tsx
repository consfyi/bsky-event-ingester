import { Trans } from "@lingui/react/macro";
import { Alert, Text } from "@mantine/core";
import { IconExclamationCircle } from "@tabler/icons-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function LoadErrorAlert({ error }: { error: any | null }) {
  return (
    <Alert
      color="red"
      title={<Trans>Error</Trans>}
      icon={<IconExclamationCircle />}
    >
      <Text size="sm">
        <Trans>An error occurred while attempting to load this data.</Trans>
      </Text>
      {error != null ? <pre>{error.toString()}</pre> : null}
    </Alert>
  );
}
