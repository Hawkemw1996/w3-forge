import FactoryWorkspace from './FactoryWorkspace';
import ForgeAssistant from './ForgeAssistant';

export default function ForgeWorkspace({ name, signOut, signingOut, signOutError }: {
  name: string; signOut(): Promise<void>; signingOut: boolean; signOutError: string;
}) {
  return <FactoryWorkspace signedInAs={name} onSignOut={signOut} signingOut={signingOut}
    signOutError={signOutError} assistant={<ForgeAssistant />} />;
}
