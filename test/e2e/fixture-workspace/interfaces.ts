export type PublicThing = {
  id: string;
};

type LocalThing = PublicThing & {
  name: string;
};
