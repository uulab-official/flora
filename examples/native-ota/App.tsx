import React, {useEffect, useState} from 'react';
import {Button, Image, Linking, SafeAreaView, ScrollView, Text, View, Platform} from 'react-native';
import {createFloraClient} from '@flora/ota';
import {createFloraNativeEngine} from '@flora/ota/native';
import fixture from './fixture.json';

const engine = createFloraNativeEngine();
const telemetry = async (event: any) => {
  try { await fetch(fixture.url + '/qa/events', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({appId: fixture.appId, platform: Platform.OS, version: fixture.version, ...event})}); } catch {}
};
export default function App() {
  const [launch, setLaunch] = useState<any>(null);
  const [status, setStatus] = useState('Starting');
  const [busy, setBusy] = useState(false);
  const update = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus('Checking');
      await telemetry({phase:'check'});
      const client = createFloraClient(await engine.getNativeConfiguration(), engine);
      const checked = await client.checkForUpdate();
      if (!checked.available) { setStatus('No update'); return; }
      setStatus('Downloading');
      await telemetry({phase:'download'});
      const result = await client.downloadUpdate();
      if (!result.downloaded) { setStatus('No download'); return; }
      setStatus('Applying ' + result.update.id);
      await telemetry({phase:'apply',updateId:result.update.id});
      await client.reload();
    } catch (error) { setStatus('Error: ' + String(error)); void telemetry({phase:'error',error:String(error)}); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let alive = true;
    engine.getLaunchInfo().then(async info => {
      if (!alive) return;
      setLaunch(info);
      setStatus(fixture.noReady ? 'Running without readiness acknowledgment' : 'Ready');
      if (!fixture.noReady) {
        await new Promise(resolve => setTimeout(resolve, 300));
        if (alive) await engine.markLaunchSuccessful(info.updateId);
      }
      await telemetry({...info, phase:'launch'});
    }).catch(error => setStatus(String(error)));
    const subscription = Linking.addEventListener('url', event => {
      if (event.url.startsWith('floraqa://update')) void update();
    });
    return () => { alive = false; subscription.remove(); };
  }, []);
  const asset = launch && Object.values(launch.assets || {})[0];
  return <SafeAreaView style={{flex: 1, backgroundColor: '#f0fdf4'}}><ScrollView contentContainerStyle={{padding: 28, gap: 16}}>
    <Text style={{fontSize: 30, fontWeight: '700'}}>{fixture.name}</Text>
    <Text testID="version" style={{fontSize: 26}}>Bundle {fixture.version}</Text>
    <Text selectable testID="status">{status}</Text>
    <Text selectable testID="launch-info">{JSON.stringify(launch, null, 2)}</Text>
    {typeof asset === 'string' && <Image testID="ota-asset" source={{uri: asset}} style={{width: 72, height: 72}} />}
    <View><Button title="Download and apply OTA" disabled={busy} onPress={update} /></View>
    <Text>Flora SDK · Native engine · No EAS</Text>
  </ScrollView></SafeAreaView>;
}
