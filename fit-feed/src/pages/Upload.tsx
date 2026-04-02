interface Props {
  uid: string;
}

export default function Upload({ uid }: Props) {
  return (
    <div>
      <p>Upload Page (uid: {uid})</p>
    </div>
  );
}
