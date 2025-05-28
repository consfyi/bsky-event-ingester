import { Trans } from "@lingui/react/macro";
import { Alert, Code, Text } from "@mantine/core";
import { IconExclamationCircle } from "@tabler/icons-react";
import { ErrorBoundary } from "react-error-boundary";

export default function SimpleErrorBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <Alert
          mt={{ lg: "xs" }}
          mx={{ base: 0, lg: "xs" }}
          color="red"
          title={<Trans>Error</Trans>}
          icon={<IconExclamationCircle />}
        >
          <Text size="sm" mb="xs">
            <Trans>An error occurred while attempting to load this data.</Trans>
          </Text>
          <Code block p={0} bg="transparent">
            {error.toString()}
          </Code>
        </Alert>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
