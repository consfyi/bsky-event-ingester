import { type MetaFunction } from "react-router";
import ConsListPage from "~/components/ConsListPage";
import clientMetadata from "../../public/client-metadata.json";
import ListView, { LayoutOptions } from "~/components/cons/ListView";

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  { title: clientMetadata.client_name },
];

export default function Index() {
  return <ConsListPage LayoutOptions={LayoutOptions} Component={ListView} />;
}
