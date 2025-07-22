import { Trans } from "@lingui/react/macro";
import { Box, Button, Stack, Text } from "@mantine/core";
import * as qp from "~/qp";
import { DEFAULT_FILTER_OPTIONS, FilterOptions } from "./FilterBar";

export default function EmptyState({
  filter,
  setFilter,
}: {
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
}) {
  return (
    <Box px="sm">
      <Stack ta="center" gap="xs" py="xl">
        <Text h={38} fw={500}>
          <Trans>No cons to display.</Trans>
        </Text>

        {!qp.equals(FilterOptions, filter, DEFAULT_FILTER_OPTIONS) ? (
          <Box>
            <Button
              onClick={() => {
                setFilter(DEFAULT_FILTER_OPTIONS);
              }}
            >
              <Trans>Clear all filters</Trans>
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}
