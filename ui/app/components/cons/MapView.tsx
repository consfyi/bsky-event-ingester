import { Box, Center, Container, Loader } from "@mantine/core";
import { Suspense, useState } from "react";
import { ConWithPost } from "~/hooks";
import * as qp from "~/qp";
import FilterBar, {
  FilterOptions,
  LayoutSwitcher,
  useFilterPredicate,
} from "../FilterBar";
import Map from "../Map";

export const LayoutOptions = qp.schema({
  center: qp.scalar(
    qp.tuple({ lat: qp.float, lng: qp.float, zoom: qp.float }, " ")
  ),
});
export type LayoutOptions = qp.InferSchema<typeof LayoutOptions>;

export default function MapView({
  cons,
  layout,
  setLayout,
  filter,
  setFilter,
}: {
  cons: ConWithPost[];
  layout: LayoutOptions;
  setLayout(layout: LayoutOptions): void;
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
}) {
  const [center] = useState(layout.center ?? null);
  const pred = useFilterPredicate(filter);
  const filteredCons = cons.filter(pred);

  return (
    <Box style={{ position: "relative" }}>
      <Container
        size="lg"
        px={0}
        style={{
          left: 0,
          right: 0,
          top: 50,
          position: "absolute",
          zIndex: 1,
        }}
      >
        <FilterBar
          cons={cons}
          filledButton={true}
          filter={filter}
          setFilter={setFilter}
          rightSection={
            <>
              <LayoutSwitcher filter={filter} layoutType="map" />
            </>
          }
        />
      </Container>

      <Suspense
        fallback={
          <Center p="lg">
            <Loader />
          </Center>
        }
      >
        <Box h="100dvh" mt={-50}>
          <Suspense
            fallback={
              <Center p="lg" h="100%">
                <Loader />
              </Center>
            }
          >
            <Map
              cons={filteredCons}
              initialCenter={center}
              setCenter={(center) => setLayout({ ...layout, center })}
            />
          </Suspense>
        </Box>
      </Suspense>
    </Box>
  );
}
