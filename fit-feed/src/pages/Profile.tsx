interface Props {
  uid: string;
}

export default function Profile({ uid }: Props) {
  return (
    <div>
      <p>Profile Page (uid: {uid})</p>
    </div>
  );
}
