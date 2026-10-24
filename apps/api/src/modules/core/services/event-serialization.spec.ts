import { EventService } from './event.service';

jest.mock('@garmin/fitsdk', () => ({}));

describe('calendar provider links', () => {
  it('keeps the public Strava link ID while storage uses a scoped ID', () => {
    const service = Object.create(EventService.prototype) as EventService;
    const event = {
      eventId: 1,
      name: 'My session',
      training: null,
      competition: null,
      note: null,
      activity: {
        provider: 'STRAVA',
        externalId: 'strava:2:123',
        description: 'My notes',
      },
    };
    expect(service.prismaEventToEvent(event as never)).toMatchObject({
      externalId: '123',
      provider: 'STRAVA',
      name: 'My session',
      description: 'My notes',
    });
  });
});
