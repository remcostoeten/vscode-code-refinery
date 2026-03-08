export type PublicProps = {
  id: string;
};

type LocalProps = {
  value: string;
};

export function Widget(props: LocalProps): PublicProps {
  return { id: props.value };
}
