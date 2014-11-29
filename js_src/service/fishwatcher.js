/**
 * Service for watching which fish can be caught right now.
 */

goog.provide('ff.service.FishWatcher');

goog.require('ff');
goog.require('ff.service.EorzeaTime');
goog.require('ff.service.FishService');
goog.require('ff.service.WeatherService');
goog.require('goog.array');
goog.require('goog.events.EventHandler');
goog.require('goog.events.EventTarget');
goog.require('goog.log');
goog.require('goog.math.Range');



/**
 * @constructor
 * @extends {goog.events.EventTarget}
 */
ff.service.FishWatcher = function() {
  goog.base(this);

  /** @protected {goog.log.Logger} */
  this.logger = goog.log.getLogger('ff.service.FishWatcher');

  /** @private {!ff.service.EorzeaTime} */
  this.eorzeaTime_ = ff.service.EorzeaTime.getInstance();

  /** @private {!ff.service.FishService} */
  this.fishService_ = ff.service.FishService.getInstance();

  /** @private {!ff.service.WeatherService} */
  this.weatherService_ = ff.service.WeatherService.getInstance();

  this.handler_ = new goog.events.EventHandler(this);
  this.registerDisposable(this.handler_);

  // Check fish whenever the fish data changes.
  this.handler_.listen(
      this.fishService_,
      ff.service.FishService.EventType.FISH_CHANGED,
      this.checkFish_);
  this.handler_.listen(
      this.weatherService_,
      [ff.service.WeatherService.EventType.WEATHER_UPDATED,
       // Compute when the interval changes, otherwise midnight is a problem.
       ff.service.WeatherService.EventType.WEATHER_INTERVAL_CHANGED],
      this.checkFish_);

  // Check fish right now.
  this.checkFish_();
};
goog.inherits(ff.service.FishWatcher, goog.events.EventTarget);
goog.addSingletonGetter(ff.service.FishWatcher);


/**
 * The events dispatched by this object.
 * @enum {string}
 */
ff.service.FishWatcher.EventType = {
  CATCHABLE_SET_CHANGED: ff.getUniqueId('catchable-set-changed')
};


/**
 * Checks to see which fish can be caught right now and updates the
 * corresponding fish.
 * @private
 */
ff.service.FishWatcher.prototype.checkFish_ = function() {
  goog.log.info(this.logger, 'Checking fish for catchable ranges.');

  var eorzeaDate = this.eorzeaTime_.getCurrentEorzeaDate();
  var currentHour =
      eorzeaDate.getUTCHours() + (eorzeaDate.getUTCMinutes() / 60.0);

  goog.array.forEach(this.fishService_.getAll(), function(fish) {

    // Update time ranges on each fish.
    this.computeAndSetTimeRanges_(fish, eorzeaDate, currentHour);

    // Compute and sort the catchable ranges.
    var catchableRanges = this.computeCatchableRanges_(fish);
    goog.array.sort(catchableRanges, this.byEarliestRange_);
    fish.setCatchableRanges(catchableRanges);

  }, this);

  this.dispatchEvent(ff.service.FishWatcher.EventType.CATCHABLE_SET_CHANGED);
};


/**
 * Computes and sets the previous and next time ranges for a fish.
 * @param {!ff.model.Fish} fish
 * @param {!goog.date.UtcDateTime} eorzeaDate
 * @param {number} currentHour
 * @private
 */
ff.service.FishWatcher.prototype.computeAndSetTimeRanges_ = function(
    fish, eorzeaDate, currentHour) {
  var hoursUntilNextStart = this.getHoursUntilNextHour_(
      currentHour, fish.getStartHour());
  var nextStartMs = eorzeaDate.getTime() + this.eorzeaTime_.hoursToMs(
      hoursUntilNextStart);
  var nextRange = new goog.math.Range(
      nextStartMs,
      nextStartMs + this.eorzeaTime_.hoursToMs(fish.getRangeLength()));
  var previousRange = new goog.math.Range(
      nextRange.start - ff.service.EorzeaTime.MS_IN_A_DAY,
      nextRange.end - ff.service.EorzeaTime.MS_IN_A_DAY);
  fish.setTimeRanges(previousRange, nextRange);
};


/**
 * Figures out the number of hours (including minutes) until the target appears
 * relative to the current time.
 * @param {number} current The current hours (including minutes) of the day
 *     (e.g. 4.5 is 4:30am).
 * @param {number} target The target hour.
 * @return {number} The number of hours until the target.  Never negative.
 * @private
 */
ff.service.FishWatcher.prototype.getHoursUntilNextHour_ = function(
    current, target) {
  if (current <= target) {
    return target - current;
  } else {
    return 24 + target - current;
  }
};


/**
 * Figures out the catchable ranges based on the intersections of weather ranges
 * with the fish time ranges assuming the weather is in the fish weather set.
 * If the fish has no weather requirement, the fish's time ranges are returned.
 * @param {!ff.model.Fish} fish
 * @return {!Array.<!goog.math.Range>}
 * @private
 */
ff.service.FishWatcher.prototype.computeCatchableRanges_ = function(fish) {
  // Shortcut optimization: if there are no weather requirements, the
  // catchable ranges are simply the time ranges.
  if (fish.getWeatherSet().isEmpty()) {
    return [fish.getPreviousTimeRange(), fish.getNextTimeRange()];
  }

  // Compute the intersections of weather ranges with time ranges.
  var weatherRanges = this.weatherService_.getWeatherRangesForArea(
      fish.getLocation().getArea());
  var intersections = [];
  goog.array.forEach(weatherRanges, function(weatherRange, i, arr) {
    // No need to look at the first weather range since it's in the past.
    if (i == 0) {
      return;
    }

    // First, see if the fish has a previous weather requirement.
    var previousWeatherRequired = fish.getPreviousWeatherRequired();
    if (goog.isDefAndNotNull(previousWeatherRequired)) {
      var previousWeather = weatherRanges[i - 1].getWeather();
      if (previousWeather != previousWeatherRequired) {
        return;
      }
    }

    // The fish satisfies, the previous weather requirement, so now check if the
    // current weather is in the set of catchable weather.
    if (!fish.getWeatherSet().contains(weatherRange.getWeather())) {
      return;
    }

    // All requirements satisfied, so compute exact catchable intersections.
    this.addIntersection_(
        intersections, weatherRange.getRange(), fish.getPreviousTimeRange());
    this.addIntersection_(
        intersections, weatherRange.getRange(), fish.getNextTimeRange());
  }, this);

  return intersections;
};


/**
 * Figures out if there is an intersection of the two ranges and adds it to the
 * list of intersections.  If the ranges only intersect on a single point, it
 * is *not* considered an intersection.
 * @param {!Array.<!goog.math.Range>} intersections
 * @param {!goog.math.Range} range1
 * @param {!goog.math.Range} range2
 * @private
 */
ff.service.FishWatcher.prototype.addIntersection_ = function(
    intersections, range1, range2) {
  var intersection = goog.math.Range.intersection(range1, range2);
  if (intersection && intersection.getLength() > 0) {
    intersections.push(intersection);
  }
};


/**
 * Compares two ranges in order to sort the earlier ranges first.
 * @param {!goog.math.Range} r1
 * @param {!goog.math.Range} r2
 * @return {number}
 * @private
 */
ff.service.FishWatcher.prototype.byEarliestRange_ = function(r1, r2) {
  return r1.start - r2.start;
};
