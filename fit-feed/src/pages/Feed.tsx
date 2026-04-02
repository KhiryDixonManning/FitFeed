interface Props {
  uid: string;
}

export default function Feed({ uid }: Props) {
  return (
    <div>
      <p>Feed Page (uid: {uid})</p>
    </div>
  );
}
